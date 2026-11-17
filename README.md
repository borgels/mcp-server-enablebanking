# mcp-server-enablebanking

An MCP server for company bank accounts through [Enable Banking](https://enablebanking.com/)
(PSD2 account information): list accounts, read balances, read transactions.

It is **read-only by construction** — the client has no payment or transfer call, and
the Enable Banking application is not registered for payment initiation. And it is
**hard-scoped to one company per instance**: which account belongs to which company is
decided by a reviewed registry, never by the bank consent or by a tool argument.

This is an independent, unofficial project. It is not developed, endorsed or supported by Enable Banking.

## Who owns an account

A bank consent is a poor authority for that. One MitID business login often reaches
the accounts of several companies, and a consent happily contains accounts nobody has
decided about. So the server does not trust it:

- **The account registry decides** (`ENABLEBANKING_ACCOUNTS_PATH`, see
  [`deploy/accounts.example.json`](deploy/accounts.example.json)). One file for all
  companies: CVR, name, and the IBANs that belong to each. An IBAN under two companies,
  a bad checksum or a duplicate id fails startup.
- **The instance is pinned** to one company (`ENABLEBANKING_COMPANY`). No tool takes a
  company argument.
- **Binding happens once, narrowly.** When a consent is completed, only accounts whose
  IBAN is registered to this company are kept. The uids of other companies' accounts
  are discarded — the store never holds a handle on them — and a consent containing
  nothing of this company is revoked at the bank immediately.
- **Checked again on every call.** A read resolves the account through the registry
  *now*, then through the consent. Remove an IBAN from the registry and the next call
  is refused; nothing at the bank has to change.
- **The bank must agree.** Account details are compared with the registered IBAN; a
  uid that suddenly answers for another account is refused.
- **Isolation at rest.** Bank sessions are encrypted (AES-256-GCM) with keys derived
  per company, and the store file is bound to its company; a store mounted into the
  wrong instance cannot be opened.

Unregistered accounts found in a consent are reported to the admin in full (so they can
be added to the registry, followed by `enablebanking_refresh_consent`); accounts
registered to another company are reported masked only.

## Tools

**Read** (everyone in the endpoint's group):

| Tool | |
|---|---|
| `enablebanking_search_capabilities` | find the right tool |
| `enablebanking_list_accounts` | the company's registered accounts, consent status and expiry |
| `enablebanking_get_balances` | booked/available balance of one account |
| `enablebanking_get_account_details` | the bank's product, currency, credit limit |
| `enablebanking_list_transactions` | bank lines in a period, newest first, with totals; filter by text, direction, amount |

Accounts are named by their registry id (`drift`) or IBAN. Amounts are decimal strings
(never floats); negative means money left the account; totals are summed in minor units.

**Consent** (only with `ENABLEBANKING_ENABLE_CONSENT=true`; gated by a group at the
gateway and, optionally, `ENABLEBANKING_CONSENT_ADMINS`):

| Tool | |
|---|---|
| `enablebanking_list_banks` | banks in a country, with maximum consent length |
| `enablebanking_start_consent` | returns the bank's MitID link; renewing replaces (and revokes) the previous consent at that bank |
| `enablebanking_complete_consent` | takes the address the browser landed on; binds this company's registered accounts |
| `enablebanking_refresh_consent` | re-binds an existing consent against the registry as it is now — no MitID |
| `enablebanking_revoke_consent` | closes the consent at the bank and forgets it |

The consent `state` is HMAC-signed and carries company, user, and a 30-minute expiry; it
is single-use. A redirect cannot be completed on another company's endpoint, by another
user, twice, or late. Two ways to finish a consent:

- **Confirmation page** (`ENABLEBANKING_CONSENT_CALLBACK=true`): the server answers
  `GET` on the path of `ENABLEBANKING_REDIRECT_URL`, completes the consent there and shows
  which accounts were bound (IBANs masked), with a button back to the chat
  (`ENABLEBANKING_RETURN_URL`). That path is the only one that must be reachable without
  the gateway; it does nothing without a valid, unused state, and the bank's code is
  worthless without the application's private key. The page is static HTML with
  `no-store`, `no-referrer` and a CSP that allows no script.
- **Paste** (callback off): the redirect only needs to land on a URL registered with the
  application; nothing has to listen there. The admin copies the address from the browser
  into `enablebanking_complete_consent` — no extra public surface at all.

Either way, the consent belongs to the company, not to the person who gave it: once one
authorised person has approved it with MitID, everyone the gateway lets onto the endpoint
reads the accounts without MitID of their own, until the consent expires.

## Bank limits

Banks may cap account reads made without the account holder present — PSD2 allows as
few as four per account per day. Answers are cached per account and query
(`ENABLEBANKING_CACHE_SECONDS`, default 300), and the instructions ask the model to
fetch a period in one call. Consents are time-limited (often 180 days at most);
`enablebanking_list_accounts` shows days left, and an expired or revoked consent is
reported as "renew with `enablebanking_start_consent`" rather than as a bank error.

In *restricted* production mode Enable Banking only serves accounts linked to the
application in its control panel — one more gate, outside this server.

## Identity and audit

Behind an authenticating MCP gateway (`ENABLEBANKING_TRUST_FORWARDED_USER=true`) every
request must carry the verified user in `X-MCP-User`; requests without it are refused. The HTTP
server refuses to start with that flag set unless `MCP_HTTP_TOKEN` is also set (the bearer is
compared in constant time), so only the gateway can supply the header. Without the flag, HTTP
callers all act as the static `ENABLEBANKING_DEFAULT_USER`, so the consent tools and the consent
callback are disabled over HTTP even when `ENABLEBANKING_ENABLE_CONSENT=true`; stdio is unaffected. Each tool
call is written to `ENABLEBANKING_AUDIT_LOG` with company, user, tool and account id;
arguments are hashed, and balances, transactions and the consent code are never logged.
Keep your gateway's own audit as well.

## Deployment

Run one container per company, each with its own `ENABLEBANKING_COMPANY`, data
directory and encryption key, all mounting the same read-only registry and private
key (see [`.env.example`](.env.example)). Put the HTTP transport behind a gateway that
authenticates users, forwards `X-MCP-User`, and holds the upstream `MCP_HTTP_TOKEN`.
Gate the consent tools separately there (a group), and keep the registry in your
operations repository — it names real accounts and does not belong next to the code.

The container runs as uid 1000; the data directory and key file must be readable by it
(key: mode 600).

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` (or `HOST`) | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | unset | Bearer token required on `/mcp`; at least 32 printable ASCII characters. Required when binding to a non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token on a non-loopback bind anyway (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin` (requires a token). |
| `MCP_ALLOWED_HOSTS` | see meaning | Comma-separated host names accepted in the `Host` header. By default a loopback bind only accepts localhost names and its bind address; other binds do not check `Host`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body size. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get HTTP 429; `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

Invalid numeric or boolean values stop the server at startup with a message
naming the variable. `GET /healthz` answers `{"ok":true,"company":...,"consent":...}`
without authentication, for container health checks. The consent callback path (when enabled) is
also served without the bearer token: the signed, single-use state authorises it.
`ENABLEBANKING_CACHE_SECONDS` and `ENABLEBANKING_TIMEOUT_MS` must be integers; values
outside their range are clamped as before. The `ENABLEBANKING_*` flags
(`ENABLEBANKING_TRUST_FORWARDED_USER`, `ENABLEBANKING_ENABLE_CONSENT`,
`ENABLEBANKING_CONSENT_CALLBACK`) are only on with exactly `true`; any other value
(including `TRUE` or `1`) leaves them off, unlike the `MCP_*` flags above.

## Threat model

What the embedded gateway guarantees about the application's private key
and a company's session, and what it does not. It is the yardstick for
every change that touches errors or results.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`mcp-server-enablebanking/gateway`), the surface a multi-tenant host uses.
The standalone MCP server and its consent page, configured from the
environment for one company, keep best-effort redaction of errors; they are
not held to these guarantees.

**Guaranteed:**

- **(a) The private key never reaches anything persisted or shared:** error
  texts, results, logs or files. It never leaves the instance except as a
  JWT signature to Enable Banking's fixed origin; errors are our own texts,
  and every result is redacted with the key before it leaves the instance.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status and an error code from Enable Banking's
  documented list; never a response body, a message or detail, a redirect's
  `Location`, an undocumented session status, or the cause of a network
  failure. Errors never quote a configuration value, the tool name or field
  names.
- **(c) Results go only to the company whose session it is.** The session id
  and the allowed accounts come with each call; nothing about a company is
  kept in process-wide state; an account outside the call's list is refused
  before any request.

**Not guaranteed (residual risk):** Enable Banking or a bank deliberately
echoing a company's session id or the key back in data. Results are redacted
on a best-effort basis: the key exactly, URL- and JSON-escaped, and any
piece of its content of 6 characters or more, and the session id whole, in
strings, object keys and the string form of numbers and booleans, replaced
by `"‹redacted›"` before anything is serialised. Anything otherwise
transformed is not recognised. Account ids stay: they are the data the host
needs. The MCP server (one company per instance) applies this to errors.

**What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), the consent helpers' answers and errors, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Scope.** The host is the embedding router. It is trusted and already holds the key and every credential it passes in. Out of scope: host-supplied code that misbehaves (hooks, a `toJSON` on a hook's result), and echoing back to the host a value the host itself passed in (for example a session id given in a call's credentials). In scope: values the vendor returns, and anything persisted.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key.

**The session id** is held to the same rule. Each call's session id must be
printable ASCII of at least 16 characters and share no piece with our texts
or a fallback, or the call is refused, as a thrown
`EnableBankingGatewayError` whose text and name are masked. It is not
refused as a result, because the fixed fields of a result (`isError`) could
hold a piece of it. Its pieces are then part of the sink check for that
call. A result that holds one is withheld; this can happen when an id in the
data happens to share 6 characters with it. `completeSession` refuses such
a session id too.

**Page tokens** are opaque: 32 random bytes that the issuing gateway
instance maps, in memory and for 15 minutes, to where the next page starts.
The token holds no account id, period or Enable Banking continuation key.

## Security model

- All callers share one Enable Banking application identity and the consents
  stored for this instance's company. With `ENABLEBANKING_TRUST_FORWARDED_USER=true`
  the forwarded `X-MCP-User` names the caller for the audit log and the consent
  tools; the server does not authenticate users itself.
- `MCP_HTTP_TOKEN` is a single shared secret that authenticates callers of
  the HTTP endpoint; it does not identify individual users. Per-user
  authentication and authorization belong in an identity-aware gateway or
  proxy in front of this server.
- Access to a tool is access to every registered account of the instance's
  company; there is no per-user account filter inside the server.
- The HTTP server does not terminate TLS. Run it on loopback or a private
  network, behind a TLS-terminating proxy when traffic leaves the host.

## Embedding (`mcp-server-enablebanking/gateway`)

For a host that serves many companies from one process and does its own
per-user authorization and logging. The standalone server above is unchanged;
the registry, the session store and the consent tools are not used on this
path. Instead the host keeps each company's consent and passes it with every
call.

```ts
import {
  createEnableBankingGateway,
  enableBankingToolCatalog,
  enableBankingServiceCatalog,
  resolveEnableBankingReadTarget,
} from 'mcp-server-enablebanking/gateway';

const gateway = createEnableBankingGateway({
  applicationId: '<application id>', // the JWT kid
  privateKey: pemText,                // or a KeyObject
  // apiBaseUrl, timeoutMs (default 30 s), maxResponseBytes (default 4 MB), fetchImpl
});

const result = await gateway.callTool('get_balances', { account: accountId }, {
  caller: 'someone',
  requestId: 'r-1',
  credentials: { sessionId, accountIds }, // this company's consent, as stored by the host
});
```

- **Nothing from the environment.** The application id and key are given at
  creation; no `ENABLEBANKING_*` variable is read. A call without
  `credentials`, or with a blank session id or an empty `accountIds`, is
  refused before any request; there is no fallback.
- **The account allowlist.** `accountIds` are the Enable Banking account uids
  the company consented to and the host stored. They take the place of the
  registry: an `account` argument must equal one of them exactly (no case
  folding, trimming or decoding), and anything else is refused before any
  request. Each call also reads the session at Enable Banking and refuses an
  account the session no longer contains, a session that is not `AUTHORIZED`,
  and a consent past its `valid_until`.
- **Read-only.** There is no payment initiation anywhere in this surface: no
  tool, no client method, no endpoint in the catalog.
- **Fixed targets.** Every request is one of the endpoints in
  `enableBankingServiceCatalog`, on the one origin given at creation (https).
  Identifiers placed in a path must be letters, digits and dashes. Redirects
  are not followed, every request has a time limit, and response bodies are
  read up to `maxResponseBytes`.
- **No Enable Banking text in errors.** An HTTP error gives the status, our
  own hint and, when Enable Banking names one, an error code from its
  documented list; never the body's message or detail (an over-limit body is
  discarded). Redirect errors do not quote the `Location`, network errors do
  not repeat their cause, a session status is named only when it is a
  documented one, and errors about the options, the environment or the
  input do not quote the rejected value, tool name or field names.
- **Redaction.** Each gateway owns a redactor holding its private key; each
  call forks it and adds the call's session id (the consent helpers add the
  code). Every result is redacted as data, before it is serialised, object
  keys included: the key exactly, URL- and JSON-escaped, and any piece of its
  content of 6 characters or more; the session id whole. Account ids stay.
  The consent helpers' answers are redacted with the key alone (they carry the
  session id on purpose). Error messages are also redacted for UUID-shaped
  identifiers, JWTs and PEM blocks, and only then shortened. Nothing is added
  to process-wide state. `test/gateway-leaks.test.ts` proves this through
  every channel.

### Tools

| Tool | Returns | Exposes | Transaction details |
|---|---|---|---|
| `list_accounts` | The connected accounts: id, name, masked IBAN, currency, product; when the consent expires | `accounts` | no |
| `get_balances` | Balances of one account (booked, available), decimal strings | `balances` | no |
| `list_transactions` | Bank lines of one account in at most 366 days (default the last 30 including today, booked only), with counterparty, text, reference and totals; at most 1,000 rows per call, paged with `nextPageToken`/`pageToken` (an opaque id kept by the gateway instance for 15 minutes, bound to session, account, period and status) | `transactions` | yes |

`enableBankingToolCatalog` (deeply frozen) gives each tool's definition plus
`upstream` (every request it may make), `broad` (always `false`),
`defaultRead`, a one-sentence `summary` for people, `exposure` and
`transactionDetails`, so a host can build fixed roles: a role that may see
balances only gets the tools where `transactionDetails` is `false`.
`resolveEnableBankingReadTarget(tool, input)` applies callTool's input checks
and returns the account and period a call will read, for the host's log.

### Consent helpers

Plain functions on the gateway instance, for the host's own connect page.
They are not tools, so an AI client cannot reach them. They throw
`EnableBankingGatewayError` with a redacted message and no `cause`. An
error that would still hold a piece of a registered value after sealing
(checked raw and encoded), and any call where Enable Banking returned a
session id that is not printable ASCII, ends in the ultimate fallback
instead: a plain `Error` with an empty message and the stack `Error`.

- `listBanks({ country = 'DK', psuType = 'business' })`: banks offering
  account information, with `maximumConsentDays`.
- `startAuthorization({ bank, country, psuType, redirectUrl, state, validUntil?, language? })`:
  checks `validUntil` against the bank's `maximum_consent_validity` (default:
  the maximum; 90 days when the bank states none), and returns the bank's
  `url`. `redirectUrl` must be registered with the application. `state` is the
  host's own unguessable, single-use value: keep it, and compare it with the
  `state` on the redirect before completing.
- `completeSession({ code })`: exchanges the code from the redirect for
  `{ sessionId, validUntil, bank, psuType, accounts: [{ id, name, maskedIban, currency }] }`.
  Store `sessionId` and the ids of the accounts the company chose as its
  credentials.
- `sessionStatus({ sessionId })`: status, `validUntil` and account ids, for
  renewal reminders.
- `endSession({ sessionId })`: closes the session and ends the consent at the
  bank.

Enable Banking API reference: <https://enablebanking.com/docs/api/reference/>.

## Run

```bash
npm install
npm test
npm run dev:http        # streamable HTTP on :3000/mcp (stateless)
npm run check:accounts -- path/to/accounts.json
```

## Licence

Apache-2.0.
