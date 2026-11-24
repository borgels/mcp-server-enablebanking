# Sandbox checklist

The tests in this repository run against stubbed answers built from Enable Banking's API description, with made-up
data. They prove what the server sends and how it treats each documented answer. They cannot prove how the live API
and a real bank behave. This list is what remains to be checked with a real application, and what a nightly test
against the sandbox needs.

Sources and the date read are in [capability-map.md](capability-map.md).

## What could not be verified without an application

| # | Question | How to check | Expected |
|---|---|---|---|
| 1 | Are `Psu-*` headers accepted on details, balances and transactions, and refused in part with 422 `PSU_HEADER_NOT_PROVIDED`? | Read balances at a bank that lists `required_psu_headers`, with all, with one of several, and with none | 200, 422, 200 |
| 2 | Does a read with `Psu-*` headers stay outside the bank's limit for background reads? | Production only: more than four reads in a day with headers, at a bank known to apply the limit | No `ASPSP_RATE_LIMIT_EXCEEDED` |
| 3 | What does the limit count: reads per consent, per account, or per account and endpoint? | Production only: background reads spread over two accounts and three endpoints until 429 | Record per bank |
| 4 | Is `GET /sessions/{session_id}` free of the bank's limit? | Many session reads in a row, then a balance read | No 429 from session reads |
| 5 | Which error code and status does each ended session give on `GET /sessions` and on an account read: expired, closed by `DELETE`, revoked by the person at <https://enablebanking.com/data-sharing-consents/>? | End a sandbox session each way, then read | A session status or one of `EXPIRED_SESSION`, `CLOSED_SESSION`, `REVOKED_SESSION`; each maps to its fixed code |
| 6 | What does `DELETE /sessions/{session_id}` answer for a session that is already closed? | Delete twice | The second is taken as "already ended" (`CLOSED_SESSION` or `WRONG_SESSION_STATUS`); anything else must be added to the mapping |
| 7 | What does an application that is not allowed the service answer? | A read with an application that is inactive, or from an address that is not allowed | `ACCESS_DENIED`, `UNAUTHORIZED_ACCESS` or `UNAUTHORIZED_IP`: `application_refused`, never an ended consent |
| 8 | Restricted production mode: what do `POST /sessions` and `GET /sessions` hold when the person consents to accounts of which none, or only some, are linked? | A restricted production application with one linked account; consent to two | None linked: empty `accounts` or `NO_ACCOUNTS_ADDED`. Some linked: only those. |
| 9 | Does `access.accounts` on `POST /auth` narrow the consent at Danish banks, or do they ignore it and let the person choose at the bank? | Start a consent with one account selected, at each bank | Record per bank |
| 10 | Does `strategy=longest` ignore `date_to`, and how far back does each bank give? | Read with `strategy=longest`, within the first hour after sign-in and after it | Record per bank |
| 11 | `WRONG_TRANSACTIONS_PERIOD`: when exactly is it returned? | Ask for 120 days back, more than an hour after sign-in | 422 with the code, mapped to `period_not_available` |
| 12 | Do `transaction_id` values work on `GET /accounts/{id}/transactions/{transaction_id}`, and which banks give them? | List, then read one by its id | 200, or `TRANSACTION_DOES_NOT_EXIST`; many banks give no `transaction_id` at all |
| 13 | Are pending lines returned with `transaction_status=PDNG`, and does a bank ignore the parameter? | List with `BOOK`, `PDNG` and none | The server filters by each line's own status in every case |
| 14 | Which balance types does each bank give? | Read balances at each bank | Record per bank; every documented type has a text |
| 15 | Accounts without an IBAN (`other` with a scheme) and multi-currency accounts (`XXX`): do the views hold? | A Swedish giro account and a multi-currency account in a sandbox | Masked identification in listings; totals per currency |
| 16 | Does the session answer carry `aspsp`, `psu_type`, `created`, `authorized` and `access` for every bank? | `GET /sessions` after consent | Present; the server shows `null` where not |
| 17 | `auth_method`: is an unknown method refused by the API with a documented code, and which methods do the Danish banks list for business customers? | `GET /aspsps?country=DK`, then `POST /auth` with each method | Record per bank; the server refuses an unlisted method before the request |

Every "record per bank" row is a fact to add to the README once known. None of them changes what the server sends.

## A nightly test against the mock bank

### What the sandbox gives

- A sandbox application is registered in the control panel by a person; it gets an application id and a private key.
  There is no API for this.
- The mock bank ("Mock ASPSP") is available for every country and needs no credentials. Its accounts, balances and
  transactions are entered in the control panel, by hand or from a JSON file; the vendor offers one synthetic sample
  file. There is no API for this either.
- The mock bank returns transactions in batches of 10, newest first, so paging is exercised with as few as 11 lines.
- The mock bank has no payment initiation. This server needs none.
- Sandbox and production share the API address; the application decides the environment
  (`GET /application` gives `environment`).

### Can the sign-in be done without a browser?

Not by anything the documentation describes. `POST /auth` returns an address on the vendor's authorisation pages;
a person, or a browser, must open it, pass the vendor's terms page and the mock bank's page, and is then redirected
to the application's `redirect_url` with `code` and `state`. The documentation gives no endpoint that completes an
authorisation for the application, and the pages are the vendor's own, free to change. Driving them with a headless
browser would work until they change and would be testing the vendor's pages, not this server.

What a nightly test can do without a browser is everything after the sign-in, for as long as the session lasts.

### Setup, once per consent period (by a person)

1. Register a sandbox application; store its id and private key as secrets of the test job.
2. In the control panel, create mock bank data: at least two accounts in two currencies, one of them with more than
   10 booked transactions and at least one pending, one account without an IBAN if the mock bank allows it.
3. Run the consent once: `listBanks({ country })`, `startAuthorization(...)` with the longest validity the mock bank
   allows, open the address in a browser, finish at the mock bank, and pass the `code` to `completeSession`.
4. Store the session id and the account ids as secrets of the test job. Note the date the session ends.
5. Repeat steps 3 and 4 before that date. The nightly job should fail with a clear message from seven days before.

### The nightly job (no browser)

All calls go through the gateway of this package, so the test covers the code a host runs.

| Step | Call | Checks |
|---|---|---|
| 1 | `application()` | `environment` is `SANDBOX`, `active` is true, `services` holds `AIS` |
| 2 | `listBanks({ country })` | The mock bank is listed; `psuTypes`, `maximumConsentDays`, `authMethods` and `requiredPsuHeaders` have the documented shapes |
| 3 | `sessionStatus({ sessionId })` | `AUTHORIZED`; `validUntil` more than seven days ahead; the stored account ids are all present |
| 4 | `callTool('list_accounts')` with `credentials.accounts` | No request to `/accounts/…` is made; `source` is `consent` |
| 5 | `callTool('list_accounts')` without `credentials.accounts` | One details read per account; names, currencies and masked numbers match the mock data |
| 6 | `callTool('get_account_details')` | Holder, product, currency and identifiers match the mock data |
| 7 | `callTool('get_balances')` per account | Each balance has a documented type code, a decimal amount and a currency |
| 8 | `callTool('list_transactions')` for the account with more than 10 lines | More than one page was followed; the count matches the mock data; newest first; no line appears twice |
| 9 | `callTool('list_transactions', { status: 'pending' })` and `{ status: 'all' }` | Pending lines only; booked and pending together |
| 10 | `callTool('list_transactions', { strategy: 'longest' })` | Accepted; `to` is null |
| 11 | `callTool('get_transaction_details')` with a `detailsId` from step 8, when one is given | The same line; or `transaction_not_found` |
| 12 | `callTool('summarize_transactions')` and `callTool('search_transactions')` | `derived: true`; totals equal the sums of the mock data |
| 13 | `callTool('get_balances')` with `psu` set to documentation values | 200; and with a bank that requires headers, with one missing: `presence_incomplete` |
| 14 | `callTool('get_balances')` for an account id that is not in the credentials | Refused with `account_not_connected` and no request |
| 15 | `callTool('get_balances')` with the session id of an ended sandbox session (kept from an earlier period) | An ended-consent code, not `application_refused` |

Run it once a night with `unattended: true` on every call except step 13, and keep the count of reads at the bank
low: the steps above make about a dozen. The job must never print a result body, only step names and pass or fail.

### What needs a second sandbox session, by a person

Ending a session cannot be part of the nightly job, because it would end the stored session. Check it by hand
when a session is renewed, with the old session: `endSession` once (`alreadyEnded: false`), again
(`alreadyEnded: true`), then a read with the old session id (an ended-consent code). Then keep the old session id
for step 15.

## Before production

1. Capture `GET /aspsps?country=DK` for business customers and note per bank: sign-in methods, required headers,
   maximum consent length, the beta flag.
2. Run rows 2, 3 and 8 to 11 of the first table with a restricted production application and the operator's own
   accounts.
3. Ask the vendor the questions at the end of [capability-map.md](capability-map.md).
