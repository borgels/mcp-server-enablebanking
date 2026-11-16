# Changelog

## 0.3.0 (2026-11-16)

HTTP transport hardening, upstream client hardening and dependency updates.

- The HTTP transport refuses to start on a non-loopback bind address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` overrides this explicitly.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- `PORT`, `MCP_MAX_BODY_BYTES`, `ENABLEBANKING_TIMEOUT_MS`,
  `ENABLEBANKING_CACHE_SECONDS` and boolean flags are validated at startup; invalid values stop the server instead of silently
  disabling a limit.
- Failed authentication is throttled per client address (HTTP 429 with
  `Retry-After`); valid tokens are never throttled. New variables
  `MCP_AUTH_FAILURE_LIMIT` (default 20, `0` disables) and
  `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- `Host` header check on loopback binds; new variable `MCP_ALLOWED_HOSTS`.
- HTTP 401 carries `WWW-Authenticate: Bearer`; invalid JSON gets HTTP 400
  (JSON-RPC parse error) instead of 500; oversized bodies get 413 before
  being read.
- `/healthz` keeps its payload and also answers `HEAD`; graceful shutdown on
  SIGTERM/SIGINT.
- The forwarded-user check is unchanged: `ENABLEBANKING_TRUST_FORWARDED_USER=true`
  still requires `MCP_HTTP_TOKEN`, and `MCP_HTTP_ALLOW_UNAUTHENTICATED` does not
  override it. The consent callback and `/healthz` stay unauthenticated.
- Non-integer `ENABLEBANKING_TIMEOUT_MS`/`ENABLEBANKING_CACHE_SECONDS` stop
  startup instead of silently falling back to the default; out-of-range
  integers are still clamped.
- Requests to Enable Banking use `redirect: 'manual'`: a redirect is reported as
  an error and the signed JWT and request body (e.g. the authorization code)
  are never re-sent to another location.
- Error bodies are read up to 64 KB; upstream text in errors is redacted
  before it is shortened.
- Rejected requests are logged without their query string.
- Images are published only after CI passes, from `main` and `v*` tags, with
  SBOM and provenance attestations.
- A test keeps the reported server version in sync with package.json.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32, `zod` 4.6) and
  overrides for patched transitive packages.

Upgrade notes: deployments that bind to `0.0.0.0` must set `MCP_HTTP_TOKEN`
(32+ characters) or the server exits at startup. Check that numeric variables
hold plain integers. A server bound to a loopback address behind a reverse
proxy that forwards the public `Host` header now answers 403 on `/mcp` until
that host name is listed in `MCP_ALLOWED_HOSTS`.

## 0.2.0

- Confirmation page for consents (`ENABLEBANKING_CONSENT_CALLBACK`): the bank's redirect
  completes the consent on the server and shows the accounts bound, so nothing has to be
  copied back into the chat. Attributed to the user named in the signed state; audited as
  `consent_callback`. `ENABLEBANKING_RETURN_URL` sets the page's back button.
- A forged or foreign consent state is reported as a consent error instead of a server error.

## 0.1.0

First version.

- Read-only AIS over Enable Banking: accounts, balances, account details,
  transactions (all pages, signed decimal amounts, exact totals, filters).
- One company per instance (`ENABLEBANKING_COMPANY`); a reviewed account
  registry decides which IBAN belongs to which company, checked at consent
  time and again on every call.
- Consent management behind `ENABLEBANKING_ENABLE_CONSENT`: MitID link,
  completion from the pasted redirect address with an HMAC-signed,
  single-use, company- and user-bound state; re-bind and revoke.
- Sessions encrypted at rest with per-company keys; audit log per tool call.
- Streamable HTTP transport, Dockerfile and GHCR publish.
