import { createServer as createNodeServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../enablebanking/config.js';
import { createBank, createServer as createMcpServer } from '../server.js';
import {
  assertAllowedOrigin,
  assertAuthorized,
  corsHeaders,
  getHttpConfig,
  HttpRequestError,
  readJsonBody,
  sendJson,
} from './http-helpers.js';
import { consentCallbackPath, handleConsentCallback } from './consent-page.js';

const config = getHttpConfig();
const bankConfig = loadConfig();
// Built once, at startup: a bad registry, key or store fails the container
// immediately instead of on the first user's call.
const bank = createBank(bankConfig);
const callbackPath = consentCallbackPath(bankConfig);

const httpServer = createNodeServer(async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, company: bank.company, consent: bankConfig.consentEnabled }, req);
      return;
    }

    // The bank's redirect (through the user's browser): no gateway, no token —
    // the signed, single-use state is what authorises it.
    if (callbackPath && req.method === 'GET' && req.url && new URL(req.url, 'http://local').pathname === callbackPath) {
      await handleConsentCallback(bank, bankConfig, req.url, res);
      return;
    }

    if (req.url !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' }, req);
      return;
    }

    assertAllowedOrigin(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, req, { Allow: 'POST' });
      return;
    }

    assertAuthorized(req, config);
    const body = await readJsonBody(req, config.maxBodyBytes);

    // The gateway forwards the Entra-verified user as X-MCP-User (never the
    // client's own header). Bank data without a named reader is not served.
    const forwarded = bankConfig.trustForwardedUser ? firstHeaderValue(req.headers['x-mcp-user']) : undefined;
    if (bankConfig.trustForwardedUser && !forwarded) {
      throw new HttpRequestError(401, 'Missing X-MCP-User from the gateway');
    }
    const actingAs = forwarded ?? process.env.ENABLEBANKING_DEFAULT_USER ?? 'local';

    const mcpServer = createMcpServer({ bank, config: bankConfig, actingAs });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof HttpRequestError) {
        sendJson(res, error.status, { error: error.message }, req);
        return;
      }
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, req);
    }
  }
});

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

httpServer.listen(config.port, config.host, () => {
  console.error(`Enable Banking MCP (${bank.company}) listening on http://${config.host}:${config.port}/mcp${callbackPath ? ` (consent callback on ${callbackPath})` : ''}`);
});
