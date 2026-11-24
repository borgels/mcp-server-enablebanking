# mcp-server-enablebanking

An MCP server for company bank accounts through [Enable Banking](https://enablebanking.com/)
(PSD2 account information): list accounts, read balances, account details and transactions, summarise and search
them, for banks in every country Enable Banking covers.

It is **read-only by construction** — the client has no payment or transfer call, and
the Enable Banking application is not registered for payment initiation. And it is
**hard-scoped to one company per instance**: which account belongs to which company is
decided by a reviewed registry, never by the bank consent or by a tool argument.

This is an independent, unofficial project. It is not developed, endorsed or supported by Enable Banking.

What the API offers and what this server does with each part is in
[docs/capability-map.md](docs/capability-map.md). Payment initiation is not implemented;
[docs/payment-initiation-design.md](docs/payment-initiation-design.md) says why and how it could be added
safely. [docs/sandbox-checklist.md](docs/sandbox-checklist.md) lists what remains to be checked against a
real application.

## Who owns an account

A bank consent is a poor authority for that. One business login at a bank (in Denmark: MitID) often reaches
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
| `enablebanking_list_accounts` | the company's registered accounts, consent status and expiry; no read at the bank |
| `enablebanking_get_balances` | every balance the bank gives for one account, each with its type, what the type means, and its date |
| `enablebanking_get_account_details` | the bank's description: holder, product, currency, usage, credit limit, every identifier |
| `enablebanking_list_transactions` | bank lines in a period, newest first, with totals; filter by text, direction, amount; `strategy: "longest"` for the longest history the bank gives |
| `enablebanking_get_transaction_details` | what the bank holds on one line, by the `detailsId` of a listing |
| `enablebanking_summarize_transactions` | totals per counterparty for a period (derived from the bank lines, and says so) |
| `enablebanking_search_transactions` | lines matching a text or an amount across the company's accounts (derived) |
| `enablebanking_get_consent_status` | each consent as Enable Banking holds it: status, expiry, what it covers; no read at the bank |

Accounts are named by their registry id (`drift`) or IBAN. Amounts are decimal strings in the bank's own
precision (never floats); negative means money left the account; totals are kept per currency and never added
across currencies. Booked and pending lines are separate: `status` is `booked` (default), `pending` or `all`.

Every answer from the bank has `fetchedAt`: when the bank was read. Nothing is kept between calls: every call
that shows bank data asks the bank. A
transaction answer has `complete` (false when the read stopped at the bound of 50 pages), `truncated` and, when
there are more matching lines than `limit`, `nextOffset` for the next call.

Counterparty names, texts and references on bank lines are written by other people. The tool descriptions and the
server instructions tell the model to treat them as data, never as instructions.

A failed call ends with a line `errorCode: <code>` from a fixed list (see [Error codes](#error-codes)), and
`retryAfterSeconds: <n>` where Enable Banking recommends a wait.

**Consent** (only with `ENABLEBANKING_ENABLE_CONSENT=true`; gated by a group at the
gateway and, optionally, `ENABLEBANKING_CONSENT_ADMINS`):

| Tool | |
|---|---|
| `enablebanking_list_banks` | banks in one country or all, for business or personal customers: maximum consent length, sign-in methods, the headers a bank requires, the beta flag |
| `enablebanking_start_consent` | returns the link to the bank's sign-in (`country` is required; `authMethod` picks one of the bank's methods); renewing replaces (and revokes) the previous consent at that bank |
| `enablebanking_complete_consent` | takes the address the browser landed on; binds this company's registered accounts |
| `enablebanking_refresh_consent` | re-binds an existing consent against the registry as it is now, without a new sign-in |
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
authorised person has approved it at the bank, everyone the gateway lets onto the endpoint
reads the accounts without signing in at the bank themselves, until the consent expires.

## Bank limits

- **Reads with nobody present.** Enable Banking tells a read that a person asked for from a background read by
  the `Psu-*` headers of the request, and many banks allow only four background reads a day. This server answers
  a model, not a browser, so it has no details of a person to send and never invents any: every read it makes is a
  background read. No answer from the bank is kept between calls, not even briefly in memory, so every call that
  shows bank data is a read at the bank (one per account it reads). Listing accounts and reading the consent status
  cost no read at the bank, and the instructions ask the model to fetch a period in one call.
  `ENABLEBANKING_UNATTENDED_FETCHES_PER_DAY` (default 0: off; 4 matches the common bank limit) sets a budget of
  reads at the bank per consent in any 24 hours; when it is used up, a call is refused with `unattended_limit` and
  the time of the next possible read, instead of being sent and refused by the bank.
- **The bank's own limit.** `rate_limited` with `retryAfterSeconds: 21600`: Enable Banking recommends waiting six
  hours. A search stops at the first account the bank limits and does not ask for the rest.
- **Reads after a consent ended.** One rule: *an answer is returned only for an account whose consent this server
  has no word against at the moment the answer is returned.* Every read resolves the account through the registry
  and the stored consent of this company on that call, before the bank is asked. The moment any answer from Enable
  Banking says a consent is over, or that an account has left it, reads of it are refused here (`consent_revoked`,
  `consent_expired`, `consent_not_active`, `account_not_in_consent`), until Enable Banking shows it in order again
  or a new consent is completed. That holds for calls running side by side too: a read that was waiting for the
  bank when the consent was withdrawn, revoked, replaced or refreshed without its account returns nothing; a search
  checks every account again once its last account is read and drops what an account gave when its consent or the
  account was withdrawn meanwhile (the account is then shown with `read: false` and why); a status answer in order
  or a refresh that was on its way when a withdrawal was learned does not lift it or bind anything, and the consent
  status tool shows such a consent as changed (`problem`, no `status`). A word against a consent or an account in
  any answer (ended, expired, an account no longer listed) is acted on whenever that answer arrives, also when the
  consent changed while it was on its way. "At the moment the answer is returned" is meant literally: every tool
  that answers with bank data (balances, account details, transactions, one transaction's details, the summary,
  the search, and the consent status) checks the consent and every account its answer comes from once more after
  its last await, the audit line included, and returns the answer with nothing awaited in between. That check is
  made in one place, the response path every tool goes through, so a tool cannot skip it: an answer the bank code
  did not mark for it is withheld. A consent revoked, or an account withdrawn, while the audit line is written
  stops the answer (a search shows the account as not read, with why). The server learns it from:
  - a read at the bank that fails with an ended consent or a missing account, from any tool;
  - `enablebanking_get_consent_status`: an error for the session, a status other than `AUTHORIZED`, a date that
    has passed, an account the session no longer lists;
  - `enablebanking_refresh_consent`: the same, before anything is bound;
  - `enablebanking_revoke_consent`, and a consent replaced by a new one;
  - the bank answering with another account than the registered one.

  A refusal of the application itself (`application_refused`, `application_restricted`, `access_refused`) leaves
  read access as it is; the next read asks the bank again. `enablebanking_list_accounts` shows an account the server
  has such word against as `consent_ended`. A read does not ask Enable Banking for the session first: a consent
  ended at the bank that nobody has asked about yet is learned from the bank's answer to the read itself. Each way
  of learning, and each race, has a test in `test/standalone-authority.test.ts`.
- **History.** Many banks give the full history only for about an hour after the sign-in and the last 90 days
  after that; a period the bank does not give is `period_not_available`.
- **Consents are time-limited** (often 180 days at most). `enablebanking_list_accounts` and
  `enablebanking_get_consent_status` show the days left, and an expired or revoked consent is reported as "renew
  with `enablebanking_start_consent`" rather than as a bank error. A refused application (`application_refused`)
  is not reported as an ended consent.

In *restricted* production mode Enable Banking only serves accounts linked to the application in its control
panel. With no linked account at all the API answers `NO_ACCOUNTS_ADDED` (`application_restricted`); a consent
whose accounts are not linked holds no accounts and is revoked and reported when it is completed.

## Error codes

Both the standalone tools and the gateway name what went wrong with a code from one fixed list, decided by Enable
Banking's documented error code and not by the HTTP status:

| Code | Meaning |
|---|---|
| `consent_expired`, `consent_revoked`, `consent_not_active` | The consent ended; a person must sign in at the bank again |
| `no_consent` | No consent was given with the call, or none covers the account |
| `account_not_connected` | Not one of the company's accounts (the registry, or the host's list, says no) |
| `account_not_in_consent` | The consent at the bank does not, or no longer, hold the account |
| `account_not_accessible` | The bank does not let the account be read |
| `application_refused` | Enable Banking refused the application (key, address, service). Not the consent. |
| `application_restricted` | Restricted mode and no linked account |
| `access_refused` | A 401 or 403 without a documented code: the cause is not known |
| `rate_limited` | The bank's limit; `retryAfterSeconds` gives the recommended wait |
| `unattended_limit` | Not sent: the budget of reads with nobody present is used up |
| `bank_unavailable` | The bank did not answer properly; try later |
| `person_action_required` | The account holder must do something at the bank first |
| `period_not_available`, `invalid_period` | The bank does not give that period; the period itself is wrong |
| `presence_incomplete` | The details of the person present are malformed or lack a header the bank requires |
| `transaction_not_found`, `page_token_invalid`, `no_accounts`, `invalid_input`, `not_found`, `upstream_error` | As named |

The mapping from each Enable Banking code is in [docs/capability-map.md](docs/capability-map.md#error-codes).

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
`ENABLEBANKING_UNATTENDED_FETCHES_PER_DAY` and `ENABLEBANKING_TIMEOUT_MS` must be integers; values
outside their range are clamped as before. `ENABLEBANKING_CACHE_SECONDS` of earlier versions is no
longer read: there is no answer cache. The `ENABLEBANKING_*` flags
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
  // unattendedFetchesPerDay (default 4)
});

const result = await gateway.callTool('get_balances', { account: accountId }, {
  caller: 'someone',
  requestId: 'r-1',
  // This company's consent, as stored by the host. `accounts` is optional: what the host stored about each
  // account when the consent was completed, so listing them needs no read at the bank.
  credentials: { sessionId, accountIds, accounts },
  // Who is present: the details of the person who asked (sent as Psu-* headers), or `unattended: true`.
  psu: { ipAddress, userAgent },
});

if (result.isError) {
  result.errorCode;         // one of enableBankingProblemCodes
  result.retryAfterSeconds; // only where Enable Banking recommends a wait
}
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
- **Who is present.** Enable Banking treats a read as asked for by a person
  when the request carries `Psu-*` headers, and as a background read when it
  carries none; banks limit background reads (often four a day). The host
  says which it is, per call:
  - `psu: { ipAddress?, userAgent?, referer?, accept?, acceptCharset?, acceptEncoding?, acceptLanguage?, geoLocation? }`
    with at least one field: a person asked. The fields are sent as the
    matching headers (`enableBankingPsuHeaders` maps them) on reads at the
    bank, never on session calls. Send only what the host observed from that
    person's own device for that request; the gateway invents nothing. A
    bank's `requiredPsuHeaders` (`listBanks()`) must all be present, or the
    API answers `PSU_HEADER_NOT_PROVIDED` (`presence_incomplete`).
  - `unattended: true`: nobody is present (a schedule, a background job). No
    header is sent, and each account the call reads at the bank counts against
    `unattendedFetchesPerDay` (default 4, 0 turns the budget off) per consent
    in any 24 hours. When the budget is used up the call is refused with
    `unattended_limit` and the time of the next possible read, before any
    request. After a `rate_limited` answer from the bank, unattended reads of
    that consent pause for six hours; also when the limit shows up inside an
    answer, as when a search could read one account and not the next (the
    remaining accounts are then not asked). The pause holds for every
    unattended call that would reach the bank, the next page of a listing
    (`pageToken`) included, although a next page takes nothing from the
    budget. The budget lives in the memory of the gateway instance.
  - Neither: no header and no budget, as before 0.7.0.
  - Both, or a malformed statement: refused with `presence_incomplete`
    before any request, never turned into a background read. Malformed is
    anything but a plain object with at least one known field, each a string
    of 1 to 512 printable ASCII characters: `null`, an empty object, an
    unknown field, a value that is not a string, and any value holding a line
    break, a tab, a NUL or another control character, or anything outside
    ASCII. Each value is checked exactly as given, before anything is
    trimmed, so no value can add or change a header. `ipAddress` must be an
    IPv4 or IPv6 address of at least 7 characters, `geoLocation`
    "latitude,longitude". Only a field that is not there (or is
    `undefined`) means "not said"; `unattended` must be a boolean.
  - The person's details are sent to the bank and removed from what the
    call returns, so a bank that repeats what it was sent does not hand a
    person's address or location on to a model. The removal is done last,
    on the finished result and on every error text, after the gateway's own
    joining and spacing of the bank's texts. What it promises, and no more:
    - `ipAddress` and `geoLocation`: always removed, from every text and
      every key of the result, wherever the value stands whole: not inside a
      longer number or word (`155.0,12.0` and `55.0,12.01` do not hold the
      location `55.0,12.0`, `192.0.2.105` does not hold `192.0.2.10`). A text
      is searched as it is and as it reads with up to three layers of
      encoding undone, each layer any mix of: percent-encoding as UTF-8
      (upper- or lower-case hex, so `%2C` and `%C2%A0` alike, `+` for a
      space, and `%uXXXX`); JSON and JavaScript escapes (`\uXXXX`, `\u{X}`,
      `\xXX`, legacy octal such as `\040`, `\t`, `\n`, `\r`, `\f`, `\v`,
      `\b`, `\"`, `\/`, `\\`); and HTML character references: every numeric
      one, decimal or hex, with or without the semicolon, and every named
      one of the HTML5 table (`&emsp;`, `&ThinSpace;`, `&nbsp` without its
      semicolon, `&comma;` and the rest), decoded as a browser decodes text
      by the `entities` package. Each of those readings is also read
      normalised: NFKC (fullwidth and other compatibility characters become
      what they stand for), digits of any script as ASCII digits, any dash
      as a minus, and `·`, `٫`, `。`, `،`, `、`, `‚` and `؛` as a point, comma or
      semicolon; and without the characters that are not seen (format
      characters such as zero-width ones, the soft hyphen and direction
      marks, and combining marks). Any Unicode whitespace or separator
      (`\s`, `\p{Z}`), U+0085, U+180E, the zero-width characters
      U+200B–U+200D, U+2060 and U+FEFF, and the characters drawn blank
      (U+115F, U+1160, U+3164, U+FFA0, U+2800) separate as a space does.
      Also in another spelling that says
      the same: an IPv6 address in upper case, written out in full or
      shortened differently, an IPv4 address as an IPv4-mapped IPv6 address.
      A location also as any two numbers equal to its latitude and longitude:
      with any number of trailing zeros, with a decimal point or a decimal
      comma, a minus written as `-`, the minus sign `−` or another dash, and
      with a comma, a semicolon or separators between them. Numbers are
      matched whole, so a coordinate inside a longer number, an amount
      (`1.055,12 kr.`, `1055,12 DKK`), a date or an account number is left
      as it is; two whole numbers (`55 12`, `55,12`) are never taken as a
      location. The location as it was sent is found the same way, with the
      same whole-number boundaries, not by a separate plain-text match. A
      location is "latitude,longitude" with a decimal point and at least one
      decimal in both numbers (`55.6761,12.5683`); a position in whole
      degrees such as `55,12` is refused with `presence_incomplete`, and the
      redactor does not take it either: it says no more than an area of
      about 100 km and is written exactly as a Danish amount, so `55,12 kr.`
      in a bank line stays as it is. Not removed: a location rounded, with
      its numbers in the other order, in degrees and minutes, with letters
      or other signs (`/`, `|`) between its numbers, or split over several
      fields.
    - The other fields (`userAgent`, `referer` and the `accept` fields):
      best effort. A value of 8 characters or more is removed where it
      stands whole, in the same encodings and with any whitespace between
      its words. A shorter value is left in: a browser name of a few
      letters or a two-letter language would blank the same word in the
      bank's own lines.
    - Not removed, for any field: a value the bank has changed (cut short,
      rounded, in other letter case, re-ordered, hashed, translated, or in
      an encoding not listed above) or cut up over several fields that the
      result shows apart.
    - It is a guard against an echo, not anonymity: what a bank writes
      about a payment can identify a person in other ways, and that text
      is the answer.
- **Listing accounts without a read at the bank.** With
  `credentials.accounts` (`{ id, name?, maskedIban?, currency?, product?, identification? }`
  per account, as `completeSession` returned them), `list_accounts` answers
  from that and the session, and says `source: "consent"`. Accounts the host
  stored nothing about are read at the bank (`source: "mixed"` or `"bank"`).
  Entries for ids outside `accountIds` are ignored.
- **No answer is kept between calls.** What a call returns is read under
  that call's own authority: the session as Enable Banking holds it at that
  moment, the `accountIds` given with the call, and who is present. There is
  no answer cache, so nothing read earlier can be returned after a consent
  ended, after an account left the session, after the host took an account
  off the list, or to a caller with other accounts. The only state the
  gateway instance holds between calls is the page tokens (15 minutes; where
  to continue a listing, never bank data; the consent and the account are
  checked again on every page) and the budget of unattended reads.
- **Fixed error codes.** An error result has `errorCode`, one of
  `enableBankingProblemCodes` (see [Error codes](#error-codes)), and
  `retryAfterSeconds` where a wait is recommended. Errors thrown by the
  consent helpers have the same code as `problem`. The code is decided by
  Enable Banking's documented error code: a 401 or 403 that names
  `ACCESS_DENIED` or `UNAUTHORIZED_ACCESS` is `application_refused`, and one
  that names nothing is `access_refused`; neither is an ended consent.
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
- **Failures.** An error result from `callTool` caused by an HTTP error from
  Enable Banking (or a refused redirect) carries
  `failure: { httpStatus, requestId? }`, in the shape of mcp-server-template:
  the status, and Enable Banking's request id only when a response header
  gives one as a UUID or hex id, checked again after redaction. Never the
  body, the error code or message, or the input. A refusal of ours has none.
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
| `list_accounts` | The connected accounts: id, name, masked account number, currency, product; the consent's status, expiry, bank and customer type | `accounts` | no |
| `get_balances` | Every balance the bank gives for one account: type code and meaning, amount, currency, reference date, last change | `balances` | no |
| `get_account_details` | The bank's description of one account: holder, product, currency, usage, credit limit, every identifier in full, servicer | `balances` | no |
| `list_transactions` | Bank lines of one account in at most 366 days (default the last 30 including today, booked only), or with `strategy: "longest"` as far back as the bank gives; at most 1,000 lines per call, with `hasMore` and `nextPageToken` | `transactions` | yes |
| `get_transaction_details` | What the bank holds on one line, by its `detailsId` | `transactions` | yes |
| `summarize_transactions` | Totals per currency and per counterparty for a period (derived) | `transactions` | yes |
| `search_transactions` | Lines matching a text or an amount across up to 10 connected accounts, with each account's outcome (derived) | `transactions` | yes |

- A line has, where the bank gives them: amount (signed decimal string in the bank's precision), currency,
  direction, status, booking, value and transaction dates, counterparty name, account, bank, address and
  organisation id, remittance lines, reference number, bank transaction code, merchant category code, exchange
  rate with the instructed amount, the balance after the line, and a note. Nothing is filled in that the bank did
  not give; personal identifiers and contact details of counterparties are not passed on; a card number is masked.
- `status` is `booked` (default), `pending` (the bank's `PDNG`, `HOLD` and `SCHD`) or `all`.
- `hasMore: true` means the bank has more lines than the call returned; `nextPageToken` continues (an opaque id
  kept by the gateway instance for 15 minutes, bound to consent, account, period, status and strategy).
  `summarize_transactions` and `search_transactions` have `complete: false` when their bounds (5,000 lines; 2,500
  lines per account) stopped the read, and the search also when an account could not be read: the account is listed
  with `read: false` and its `problem`. When the bank says for any account of a search that the consent is over
  (`consent_revoked`, `consent_expired`, `consent_not_active`), the whole search is refused with that code: the
  accounts read before it were read under the same consent, and nothing of them is returned. An account that has
  left the consent (`account_not_in_consent`) is refused alone. A listing over several pages, a summary and
  `list_accounts` fail as a whole when any read they make fails.
- The derived tools are pure functions of the bank lines of the same call and say `derived: true`.
- The descriptions of the transaction tools tell the model that names, texts and references on bank lines are
  written by other people: data, never instructions.

`enableBankingToolCatalog` (deeply frozen) gives each tool's definition plus
`upstream` (every request it may make), `broad` (always `false`),
`defaultRead`, a one-sentence `summary` for people, `exposure`,
`transactionDetails` and `derived`, so a host can build fixed roles: a role
that may see balances only gets the tools where `transactionDetails` is
`false`. `resolveEnableBankingReadTarget(tool, input)` applies callTool's
input checks and returns the account (or accounts) and period a call will
read, for the host's log; a refusal has `reason` and `code`.

### Consent helpers

Plain functions on the gateway instance, for the host's own connect page.
They are not tools, so an AI client cannot reach them. They throw
`EnableBankingGatewayError` with a redacted message and no `cause`. An
error that would still hold a piece of a registered value after sealing
(checked raw and encoded), and any call where Enable Banking returned a
session id that is not printable ASCII, ends in the ultimate fallback
instead: a plain `Error` with an empty message and the stack `Error`.

- `listBanks({ country?, psuType? })`: banks offering account information,
  in one country or every country the application covers, for one kind of
  customer or both. Each has `psuTypes`, `maximumConsentDays`, `beta`,
  `sandbox`, `group`, `authMethods` (`name`, `title`, `psuType`,
  `approach`, `hidden`, and the names of any credentials the method asks for)
  and `requiredPsuHeaders`. Mark a `beta` bank as such on the connect page.
- `startAuthorization({ bank, country, psuType?, redirectUrl, state, validUntil?, language?, authMethod?, accounts?, balances?, transactions?, extendedHistory? })`:
  `country` is required (a bank is its name and country). `psuType` is
  `business` (default) or `personal`. `authMethod` must be one the bank
  offers to that kind of customer. `accounts` (at most 50, each `{ iban }` or
  `{ scheme, identification }`) asks for those accounts only; what a bank
  does without it differs per bank. Checks `validUntil` against the bank's
  `maximum_consent_validity` (default: the maximum; 90 days when the bank
  states none), and returns the bank's `url` and `authorizationId`.
  `redirectUrl` must be registered with the application. `state` is the
  host's own unguessable, single-use value: keep it, and compare it with the
  `state` on the redirect before completing. The bank's sign-in credentials
  are never carried: there is no field for them.
- `completeSession({ code })`: exchanges the code from the redirect for
  `{ sessionId, outcome, validUntil, bank, psuType, access, accounts: [{ id, name, maskedIban, currency, identificationHash, product, identification, cashAccountType, usage }] }`.
  `outcome` is `connected`, or `no_accounts` when the consent was given but
  holds no account that can be read (in restricted mode: none of the chosen
  accounts is linked to the application). Treat `no_accounts` as its own
  result on the connect page: nothing is connected, and the session should be
  ended. Store `sessionId`, the ids of the accounts the company chose, and
  what was returned about each as `credentials.accounts`. The ids change
  with every new session; `identificationHash` (Enable Banking's, or null)
  stays the same for the account, so use it to recognise an account again
  when a consent is renewed.
- `sessionStatus({ sessionId })`: `status`, `validUntil`, account ids,
  `accounts: [{ id, identificationHash }]`, `bank`, `psuType`, `createdAt`,
  `authorizedAt`, `closedAt` and `access`, for renewal reminders. Not a read
  at the bank.
- `endSession({ sessionId })`: closes the session and ends the consent at the
  bank (`DELETE /sessions/{session_id}`). Returns `{ alreadyEnded }`: true
  when Enable Banking says the session was already expired, closed, revoked
  or unknown, so removing an account, renewing a consent and closing a
  company can all call it without special cases. Any other failure throws:
  the session may still be open. From the moment it is called, the gateway
  instance returns nothing more read under the session, also not the answer
  of a call that was already under way (refused with `consent_not_active`);
  see "Answers after a withdrawal".
- `application()`: `{ environment, active, countries, services, redirectUrls }`
  as Enable Banking holds the application, for a health check. The API has no
  field that says "restricted mode"; see
  [docs/capability-map.md](docs/capability-map.md#application-restricted-production-mode).

#### Answers after a withdrawal

Every call asks Enable Banking for the session first, so what the host passes
and what the bank holds now decide the call. Calls also run side by side in
one gateway instance, so the instance keeps, in memory and for this purpose
only, what calls learn while they run: a session ended through `endSession`,
a consent Enable Banking says is over (the session's status, or a read that
fails with an ended consent), and an account it says has left the consent (the
session no longer lists it, or a read fails with `ACCOUNT_DOES_NOT_EXIST`).
After a call's last await, with nothing awaited before it returns, its answer
is checked against that: when anything was learned since the call began
against its consent, or against an account its answer may come from (the
account named, or every account of the call for `list_accounts` and a search
over all accounts), the call is refused with `consent_not_active` ("Refused:
the bank consent was ended, or an account left it, while this call was being
answered; ...") and no data. What a search learns itself about an account
it then skipped does not count against it. Only session ids, account ids and a
counter are kept, for at most 10 000 sessions; when an older entry has to be
dropped, every call under way is refused rather than trusted.

Enable Banking API reference: <https://enablebanking.com/docs/api/reference/>.

## Run

```bash
npm install
npm test
npm run dev:http        # streamable HTTP on :3000/mcp (stateless)
npm run check:accounts -- path/to/accounts.json
```

## License

The code is source-available under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

In plain words:

- **Allowed:** reading the code, running it, changing it, using it inside your own organisation (also commercially), using it for non-commercial education and research, and contributing changes back.
- **Not allowed:** making it, or something built from it, available to others as a commercial product or service that competes with it, for example a hosted service with the same functionality.
- **Becomes Apache-2.0:** each version is also licensed under the Apache License 2.0 from two years after it is released.
- **Earlier versions:** versions released before 0.5.0 were licensed under Apache-2.0 and remain so.

The terms in [LICENSE](LICENSE) are what apply; this summary does not replace them. See also [NOTICE](NOTICE).
