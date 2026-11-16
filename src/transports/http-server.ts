import {
  createServer as createNodeServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  assertAuthorized,
  assertSecureConfig,
  AuthFailureLimiter,
  corsHeaders,
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_MS,
  type HttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';

export interface HttpServerOptions {
  /**
   * Factory for the per-request MCP server, called after authentication and
   * body parsing. May throw HttpRequestError (e.g. a missing forwarded user).
   */
  createMcpServer: (req: IncomingMessage) => McpServer;
  /** Body of GET /healthz; defaults to { status: 'ok' }. */
  healthPayload?: () => unknown;
  /**
   * Handles additional unauthenticated routes before /mcp (e.g. a browser
   * redirect target). Returns true when it answered the request.
   */
  extraRoute?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
  /** Defaults to console.error. */
  log?: (line: string) => void;
  /** Time in-flight requests get on close() before connections are destroyed. */
  shutdownGraceMs?: number;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

export function createHttpRequestHandler(config: HttpConfig, options: HttpServerOptions): RequestListener {
  const createMcpServer = options.createMcpServer;
  const log = options.log ?? ((line: string) => console.error(line));
  const healthPayload = options.healthPayload ?? (() => ({ status: 'ok' }));
  const failureLimit = config.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT;
  const limiter = failureLimit > 0
    ? new AuthFailureLimiter(failureLimit, config.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS)
    : undefined;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    // Path only: a browser redirect target carries one-time codes in the query string.
    const describeRequest = () => `${req.method ?? '-'} ${(req.url ?? '').split('?')[0]?.slice(0, 200)} from ${remote}`;
    try {
      const path = (req.url ?? '/').split('?')[0];

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, healthPayload());
        return;
      }

      if (options.extraRoute && (await options.extraRoute(req, res, path ?? '/'))) {
        return;
      }

      if (path !== '/mcp') {
        throw new HttpRequestError(404, 'Not found');
      }

      assertAllowedHost(req, config);
      assertAllowedOrigin(req, config);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        throw new HttpRequestError(405, 'Method not allowed', { headers: { Allow: 'POST, OPTIONS' } });
      }

      try {
        assertAuthorized(req, config);
      } catch (error) {
        // Only failing requests are counted and throttled; a valid token is never blocked.
        if (limiter) {
          const retryAfter = limiter.retryAfterSeconds(remote);
          if (retryAfter > 0) {
            sendJson(res, 429, { error: 'Too many failed authentication attempts' }, req, {
              'Retry-After': String(retryAfter),
            }, config);
            return;
          }
          if (limiter.recordFailure(remote)) {
            log(`[http] ${remote} reached ${failureLimit} failed authentication attempts; further failures get 429`);
          }
        }
        throw error;
      }

      const body = await readJsonBody(req, config.maxBodyBytes);
      const mcpServer = createMcpServer(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      for (const [name, value] of Object.entries(corsHeaders(req, config))) {
        res.setHeader(name, value);
      }

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        log(`[http] ${error.status} ${describeRequest()}: ${error.message}`);
        if (!res.headersSent && !res.destroyed) {
          const payload = error.jsonRpcCode === undefined
            ? { error: error.message }
            : { jsonrpc: '2.0', error: { code: error.jsonRpcCode, message: error.message }, id: null };
          sendJson(res, error.status, payload, req, error.headers, config);
        }
        return;
      }

      log(`[http] 500 ${describeRequest()}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        }, req, {}, config);
      }
    }
  };
}

/**
 * Starts the HTTP transport. `config.port` 0 picks an ephemeral port. Throws
 * ConfigError for configurations refused by assertSecureConfig.
 */
export async function startHttpServer(
  config: HttpConfig,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  assertSecureConfig(config);
  const server = createNodeServer(createHttpRequestHandler(config, options));
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;

  // While shutting down, let in-flight requests finish and then drop their
  // keep-alive sockets instead of waiting for the force-close timer.
  server.on('request', (_req, res) => {
    res.on('finish', () => {
      if (closing) {
        server.closeIdleConnections();
      }
    });
  });

  return {
    server,
    port,
    close() {
      closing ??= new Promise<void>(resolve => {
        server.on('request', (_req, res) => res.setHeader('Connection', 'close'));
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
