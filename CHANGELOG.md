# Changelog

## 0.4.1 (2026-11-17)

- `completeSession` registers the session id Enable Banking returns from
  the raw answer (success or error body), before the client's
  normalisation, which can drop it, and before its format is checked.
- `completeSession` registers the session id Enable Banking returns before
  its format is checked; a value that is not printable ASCII is masked in
  the final error without being encoded. The README states the scope: the
  host is trusted; vendor values and anything persisted are in scope.
- Every secret registered during a consent helper's call, the session id
  `completeSession` receives included, is part of the final seal and the
  sink check of any error that leaves the call.
- A key object that cannot be exported, or exports no content, is refused:
  a gateway never runs without a secret to check against. Every error that
  leaves (helper errors and fallbacks, the session refusal) passes the sink
  check as a finished object, name, message, stack, status and code
  included, and is replaced by the sealed fixed fallback when it leaks.
- Consent helpers check the state, code or session id they are given as
  printable ASCII inside their error boundary, before anything encodes it,
  and refuse anything else with a fixed error in final form.
- Errors leave in final form: every error a gateway throws is a fresh
  error with no `cause`, a `stack` of just `name: message` (no frames,
  paths or function names), and name, message and stack masked against the
  secret; the sink check runs on the finished object, its non-enumerable
  fields included.
- Every element of a failure list (`failures`, `failure`, `errors`,
  `error`, `warnings`), at any depth and whatever its fields, becomes
  `{ status?, message }` with our own text; a failure context such as
  `metadata` or `amount` holds through wrappers such as `data`.
- Network, timeout and redirect errors name the method only, not the
  configured address.
- The sink check: every output of a gateway (the tool list, results, the consent helpers' answers and errors,
  construction errors) is checked in its final form, and one that holds a
  piece of 6 characters of the key or of the call's session id is
  replaced by a fixed fallback (`src/fallbacks.ts`): a withheld result or
  error, or the fixed refusal. A session id that fails admission makes
  `callTool` throw a masked `EnableBankingGatewayError`. A key that shares a
  piece with a fallback or with the tool list is refused at creation.
- Key admission: printable ASCII (0x21-0x7E) of at least 16 characters,
  checked before anything is built from the key; the corpus of our own
  string literals stays as a cheap first filter.
- A text in a failure list of a successful answer (`failures`, `errors`,
  `warnings` and the like) is replaced by our own text, like a failure
  object.
- No Enable Banking text in errors (also for the MCP server): an HTTP error
  gives the status, our hint and an error code from Enable Banking's
  documented list; the body's message and detail are not kept, an over-limit
  error body is discarded, and an undocumented code is dropped.
- Gateway: every result is redacted as data before it is serialised, keys
  included, with the instance's key (exact, URL- and JSON-escaped, and any
  6-character piece of its content) and the call's session id. A key given as
  a `KeyObject` is redacted too. The consent helpers' answers are redacted
  with the key.
- Gateway: errors no longer repeat the tool name or unknown field names; a
  session status is named only when documented; consent dates are returned
  as ISO 8601 in UTC (`validUntil`), or null when they are not a date.
- Account names over 200 characters are left out instead of cut.
- Gateway: the redaction marker is `‹redacted›`; failures reported inside a
  successful answer keep only their status; an answer body that cannot be
  read becomes our own text (an error body is dropped); consent-helper errors
  carry a code only from the documented list. The threat model's guarantees
  apply to the gateway; the standalone server keeps best-effort redaction.
- Gateway: page tokens are opaque ids (32 random bytes) that the issuing
  instance maps, in memory and for 15 minutes, to where the next page
  starts; no account id, period or continuation key is in the token. A
  continuation key over 2,048 characters ends the listing as incomplete.
- Transaction dates keep the bank's calendar date as given: a value that
  starts with a valid `YYYY-MM-DD` keeps that date (`2026-11-02T00:30:00+01:00`
  is 2 November); time zones are never converted. Anything else is null.
- Gateway key admission: a key whose content is shorter than 16 characters,
  or shares a 6-character piece with any of this server's own texts
  (`src/fixed-corpus.generated.ts`), is refused with a fixed text that never
  repeats it; the same rule refuses a session id at `completeSession` and in
  each call.
- Gateway: every string leaving it passes the redactor as the last step:
  results and refusals, construction errors, and the consent helpers'
  answers and errors.
- Failures reported inside a successful answer: a `status` of 400 or more,
  an `error` field, or a message in `failures`, `errors`, `metadata`,
  `amount` and the like keep only their status and our own text.
- Gateway: numbers and booleans whose string form matches are replaced by
  the string `"‹redacted›"`; a result is redacted first and copied as JSON
  afterwards. The README has a threat model: what is guaranteed and the
  residual risk.
- Configuration errors no longer quote the rejected value.

## 0.4.0 (2026-11-17)

Embedding surface `mcp-server-enablebanking/gateway`, so one host process can
serve many companies. The standalone stdio/HTTP server is unchanged.

- `createEnableBankingGateway({ applicationId, privateKey, apiBaseUrl?, timeoutMs?, maxResponseBytes?, fetchImpl? })`
  holds the application's credentials; nothing is read from the environment.
- `callTool(name, input, { caller?, requestId?, credentials: { sessionId, accountIds } })`.
  `accountIds` is the company's account allowlist and replaces the registry on
  this path: an account outside it is refused before any request, and the
  session at Enable Banking must still be authorised and contain it. Missing
  or empty credentials are refused with no fallback.
- Tools `list_accounts`, `get_balances` (balances only) and
  `list_transactions` (at most 366 days per period, default the last 30 days
  including today; at most 1,000 rows per call, paged with a token signed by
  the gateway instance and bound to account, period and status). Read-only: no
  payment surface.
- `enableBankingToolCatalog` (frozen; `upstream`, `broad`, `defaultRead`,
  `summary`, `exposure`, `transactionDetails`), `enableBankingServiceCatalog`
  and `resolveEnableBankingReadTarget`.
- Consent helpers on the instance (not tools): `listBanks`,
  `startAuthorization` (checks `valid_until` against the bank's maximum),
  `completeSession`, `sessionStatus`, `endSession`.
- A redactor per gateway and per call; fixed upstream targets, time limits,
  bounded response bodies, no redirects.
- `package.json` gains an `exports` map (`.`, `./gateway` and
  `./package.json`) and the build emits type declarations.

Upgrade notes: with the `exports` map, deep imports such as
`mcp-server-enablebanking/dist/server.js` no longer resolve through the
package name; import `mcp-server-enablebanking` (the stdio entry),
`mcp-server-enablebanking/gateway` or `mcp-server-enablebanking/package.json`.
The `bin` command and the container image are unchanged.

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
