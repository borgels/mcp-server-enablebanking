# mcp-server-enablebanking

An MCP server for company bank accounts through [Enable Banking](https://enablebanking.com/)
(PSD2 account information): list accounts, read balances, read transactions.

It is **read-only by construction** — the client has no payment or transfer call, and
the Enable Banking application is not registered for payment initiation. And it is
**hard-scoped to one company per instance**: which account belongs to which company is
decided by a reviewed registry, never by the bank consent or by a tool argument.

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

**Consent** (only with `ENABLEBANKING_ENABLE_CONSENT=true`; gated by a duty group at the
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
user, twice, or late. The redirect only needs to land on a URL registered with the
application (`ENABLEBANKING_REDIRECT_URL`); nothing has to listen there —
the admin copies the address from the browser into `enablebanking_complete_consent`. No
callback route, so no extra public surface.

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
request must carry the verified user in `X-MCP-User`; requests without it are refused. Each tool
call is written to `ENABLEBANKING_AUDIT_LOG` with company, user, tool and account id;
arguments are hashed, and balances, transactions and the consent code are never logged.
Keep your gateway's own audit as well.

## Deployment

Run one container per company, each with its own `ENABLEBANKING_COMPANY`, data
directory and encryption key, all mounting the same read-only registry and private
key (see [`.env.example`](.env.example)). Put the HTTP transport behind a gateway that
authenticates users, forwards `X-MCP-User`, and holds the upstream `MCP_HTTP_TOKEN`.
Gate the consent tools separately there (a duty group), and keep the registry in your
operations repository — it names real accounts and does not belong next to the code.

The container runs as uid 1000; the data directory and key file must be readable by it
(key: mode 600).

## Run

```bash
npm install
npm test
npm run dev:http        # streamable HTTP on :3000/mcp (stateless)
npm run check:accounts -- path/to/accounts.json
```

## Licence

Apache-2.0.
