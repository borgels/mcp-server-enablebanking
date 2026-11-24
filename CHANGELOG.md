# Changelog

## 0.7.0 (2026-11-24)

The whole account information part of Enable Banking's API, for both the standalone server and the embedded
gateway. What the API offers and what is done with each part is in `docs/capability-map.md` (read from the API
description `1.0.0-1c03cf81` on 2026-11-24). Still read-only: there is no payment initiation, and
`docs/payment-initiation-design.md` is a design note only. `docs/sandbox-checklist.md` lists what remains to be
checked against a real application.

Both surfaces:

- New tools: one transaction's details, totals per counterparty for a period, and a search across accounts. The
  last two are derived from the bank lines of the same call and say so (`derived: true`).
- Bank lines carry everything the bank gives: transaction date, counterparty account in any scheme, counterparty
  bank, address and organisation id, each remittance line, reference number and its scheme, the bank transaction
  code in full, merchant category code, exchange rate with the instructed amount, the balance after the line, the
  note, and `detailsId` for the details tool. Personal identifiers and contact details of counterparties are not
  passed on, and a card number is masked. Nothing is filled in that the bank did not give.
- Balances: every documented balance type with its meaning, `code` beside the `type` text, last change and last
  committed transaction. Account details: holder, description, usage, account type, holder role, credit limit,
  every identifier, servicer and address.
- No currency is assumed. A balance or an account whose currency the bank does not state has `currency: null`
  (0.6.x said `DKK`), and a missing amount is empty, not `0`.
- Amounts keep the bank's precision (`0.125` stays `0.125`, `100` stays `100`); 0.6.x rewrote every amount to two
  decimals. Totals are exact and kept per currency.
- `pending` now means the bank's `PDNG`, `HOLD` and `SCHD`. Cancelled, rejected and unspecified lines appear only
  with status `all` (0.6.x counted everything that was not booked as pending).
- A value of a kind the API description does not allow (a number or an object where it says text) is dropped
  rather than shown.
- `strategy: "longest"` on the transaction listing asks for the longest history the bank gives. An end date cannot
  be given with it.
- Every answer from the bank says when the bank was read (`fetchedAt`), and a transaction answer says truthfully
  whether there is more (`hasMore` on the gateway; `complete`, `truncated` and `nextOffset` standalone).
- Fixed error codes, decided by Enable Banking's documented error code and not by the HTTP status: an ended consent
  (`consent_expired`, `consent_revoked`, `consent_not_active`), a refused application (`application_refused`,
  `application_restricted`), an account outside the consent (`account_not_in_consent`) or not the company's
  (`account_not_connected`), the bank's rate limit (`rate_limited`, with the six hours Enable Banking recommends as
  `retryAfterSeconds`), a bank that does not answer (`bank_unavailable`), and more; the list is in the README. A
  401 or 403 that names no documented code is `access_refused`. In 0.6.x the standalone server took any 401 or 403
  as an ended consent.
- The tool descriptions and the server instructions say that names, texts and references on bank lines are written
  by other people and are data, never instructions.

Standalone server:

- New tools `enablebanking_get_transaction_details`, `enablebanking_summarize_transactions`,
  `enablebanking_search_transactions` and `enablebanking_get_consent_status`.
- `enablebanking_list_transactions`: `strategy`, `offset`, and amounts to filter by as exact decimal strings. The
  answer has `fetchedAt`, `offset`, `complete` and `nextOffset`; a read stops at 50 pages and says so.
- `enablebanking_get_balances` and `enablebanking_get_account_details` have `fetchedAt`; the bank's description of
  the account is under `details` (0.6.x: `bank`).
- `enablebanking_list_banks`: `country` and `psuType` are optional (0.6.x: Denmark and business customers), and
  each bank has its group, sign-in methods and the headers it requires.
- `enablebanking_start_consent`: `country` is required (0.6.x: Denmark), and `authMethod` and `extendedHistory` are
  new.
- A failed call ends with `errorCode: <code>` and, where a wait is recommended, `retryAfterSeconds: <n>`.
- `ENABLEBANKING_UNATTENDED_FETCHES_PER_DAY` (default 0: off): a budget of reads at the bank per consent in any 24
  hours. The standalone server has no details of a person to send, so all its reads are background reads.
- The answer cache stands under a stated rule (README, "What the cache may answer"): once any answer from Enable
  Banking says a consent is over or an account has left it (a failed read, the consent status, a refresh), nothing
  read under it is served again and reads of it are refused, until it is seen in order again or a new consent is
  completed. Before, the consent status tool could report a revoked consent and a kept balance was still served.
  `enablebanking_list_accounts` has a new account status for it: `consent_ended`.
- `enablebanking_refresh_consent` refuses a consent that is no longer authorised instead of binding to it.
- A search stops at the first account the bank's rate limit refuses.
- The account registry no longer assumes DKK for an account without a currency.
- The package ships `docs/`.

Gateway (`mcp-server-enablebanking/gateway`), every change to the surface:

- Tools: `get_account_details`, `get_transaction_details`, `summarize_transactions` and `search_transactions` are
  new, in that order after the existing ones. `list_transactions` takes `strategy`. Catalog entries have
  `derived` (boolean). The descriptions of the three existing tools are reworded; their names, inputs and
  summaries are unchanged.
- `GatewayCallContext`: `psu` (the details of the person who asked, sent as `Psu-*` headers) and `unattended`.
- `EnableBankingGatewayCredentials`: `accounts` (optional), what the host stored about each account;
  `list_accounts` then answers without a read at the bank.
- `EnableBankingGatewayOptions`: `unattendedFetchesPerDay` (default 4; 0 turns the budget off). The budget applies
  only to calls marked `unattended: true`. The gateway keeps no answer between calls: there is no cache option.
- A malformed `psu` or `unattended` (also `null`, and a value with a line break or another control character) is
  refused with `presence_incomplete`, never read as "nobody is present".
- The values of `psu` are removed from the finished result of the call, so a bank that repeats them does not hand
  them on: `ipAddress` and `geoLocation` always, however they are encoded or spelled; the other fields best
  effort, from 8 characters. The README says exactly what is promised ("Who is present"). The redaction of every
  value the gateway holds (session id, key, authorization code) now reads a text decoded before comparing, so a
  percent-encoding in lower case, a double encoding or an HTML entity no longer hides a value.
- The pause after a bank's rate limit also holds for the next page of a listing (`pageToken`).
- `GatewayToolResult`: `errorCode` on every error result and `retryAfterSeconds` where a wait is recommended. The
  fixed error texts of 0.6.x are unchanged.
- `list_accounts`: adds `source` (`consent`, `bank` or `mixed`), `consent` (status, `validUntil`, `expiresInDays`,
  bank, customer type, `authorizedAt`), `fetchedAt` when the bank was read, and `identification` for an account
  without an IBAN. `consentValidUntil` stays.
- `get_balances`: adds `fetchedAt`; each balance adds `code` and `lastCommittedTransaction`, and the `type` text of
  some balance types is reworded.
- `list_transactions`: adds `hasMore`, `fetchedAt` and `strategy`; `to` is null with `strategy: "longest"`.
- `resolveEnableBankingReadTarget`: a failure has `code`; a target can have `accounts` (the search) and `strategy`.
- `listBanks`: no default country or customer type; `EnableBankingBank` adds `maximumConsentSeconds`, `sandbox`,
  `group`, `logoUrl`, `authMethods` and `requiredPsuHeaders`.
- `startAuthorization`: `country` is required; `authMethod`, `accounts`, `balances`, `transactions` and
  `extendedHistory` are new; the result adds `authorizationId`.
- `completeSession`: adds `outcome` (`connected` or `no_accounts`) and `access`; each account adds `product`,
  `identification`, `cashAccountType` and `usage`.
- `sessionStatus`: adds `bank`, `psuType`, `createdAt`, `authorizedAt`, `closedAt` and `access`.
- `endSession`: returns `{ alreadyEnded }` (0.6.x: nothing) and no longer throws for a session that is already
  expired, closed, revoked or unknown.
- `application()` is new: the application as Enable Banking holds it.
- `EnableBankingGatewayError` has `problem`, the fixed code.
- New exports: `enableBankingProblemCodes`, `enableBankingPsuHeaders` and the types `EnableBankingProblemCode`,
  `EnableBankingPsu`, `EnableBankingKnownAccount`, `EnableBankingAuthMethod`, `EnableBankingAccountSelection`,
  `EndSessionResult` and `EnableBankingApplicationStatus`.
- `enableBankingServiceCatalog` adds the endpoints `accountTransaction` and `getApplication`.

Moving a host from 0.6.1:

1. Four tools are new. A host that keeps its own table per tool (texts, roles, log sentences) must add them before
   it starts, or leave them out of what it offers. All four are `riskLevel: "read"`; three of them have
   `transactionDetails: true`, and `get_account_details` shows the full account number and the holder's name.
2. Pass `country` to `startAuthorization`, and to `listBanks` if only one country should be listed.
3. Say who is present on every call: `psu` with what was observed from the person's own device, or
   `unattended: true` for a schedule. With neither, nothing changes from 0.6.1: no header is sent and no budget is
   kept.
4. Branch on `errorCode` instead of on the HTTP status or the text. `application_refused` and `access_refused` are
   not an ended consent.
5. Store what `completeSession` returns about each account and pass it as `credentials.accounts`, so
   `list_accounts` needs no read at the bank. Handle `outcome: "no_accounts"` as its own result.
6. `endSession` can be called for a session in any state; check `alreadyEnded` only if it matters.
7. Do not assume a currency: `currency` can be null. Do not parse amounts as two-decimal numbers. Do not match on
   the `type` text of a balance; use `code`.

Not in this version: the standalone account registry still describes companies in a Danish shape (an 8-digit
registration number, IBAN only), so accounts without an IBAN are served on the gateway path only.

## 0.6.1 (2026-11-22)

- Gateway: the consent helpers give each account's identification hash (`ConsentAccount.identificationHash`,
  `SessionStatusResult.accounts`), the same for the account in every consent while the uid changes with each session,
  so a host can recognise an account again on renewal. The hash follows Enable Banking's documented shape (base64
  parts joined by a dot); anything else is dropped. The `list_accounts` answer does not carry it.

## 0.6.0 (2026-11-22)

- Gateway: `failure: { httpStatus, requestId? }` on a `callTool` error result
  caused by an HTTP error from Enable Banking or a refused redirect, as in
  mcp-server-template 0.2.1. The request id only as a UUID or hex id (never
  one with the shape of a personal number), checked again after redaction;
  never the body, the error code or message, or the input. Refusals of the
  gateway's own carry none.

## 0.5.0 (2026-11-21)

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.5.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.4.1 (2026-11-17)

- A terminating check after sealing: an error a consent helper or a call
  throws is checked against every registered value in its raw form
  (non-ASCII included) and its encoded forms, and replaced by the
  ultimate fallback (`Error`, empty message, stack `Error`) when it
  holds a piece of one; masking can no longer create a piece. A session
  id Enable Banking returns that is not printable ASCII is never masked
  into a text: the call ends in the ultimate fallback.
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
