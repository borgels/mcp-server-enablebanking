# Capability map

What Enable Banking's API offers, and what this server does with each part. Every endpoint, parameter, field and
error code of the API description is listed with one of four marks:

- **before**: covered before version 0.7.0.
- **0.7.0**: added in version 0.7.0.
- **no**: deliberately not covered; the reason is given.
- **n/a**: not part of account information (payment initiation, see
  [payment-initiation-design.md](payment-initiation-design.md)).

"Standalone" is the MCP server for one company (`enablebanking_*` tools). "Gateway" is the embedded surface
(`mcp-server-enablebanking/gateway`).

## Sources

Read on 2026-11-24.

| Source | Address |
|---|---|
| API description (OpenAPI 3.1.0, `info.version` `1.0.0-1c03cf81`) | <https://enablebanking.com/docs/api/reference/enablebanking-api.yaml> |
| API reference | <https://enablebanking.com/docs/api/reference/> |
| Quick start | <https://enablebanking.com/docs/api/quick-start/> |
| Sandbox | <https://enablebanking.com/docs/api/sandbox/> |
| Linked accounts (restricted mode) | <https://enablebanking.com/docs/api/linked-accounts/> |
| Webhooks | <https://enablebanking.com/docs/api/webhooks/> |
| Control panel | <https://enablebanking.com/docs/api/control-panel/> |
| FAQ | <https://enablebanking.com/docs/api/faq/> |
| Widgets | <https://enablebanking.com/docs/api/widgets/> |
| Markets, Denmark | <https://enablebanking.com/docs/markets/>, <https://enablebanking.com/docs/markets/dk/> |
| TPP as a service | <https://enablebanking.com/docs/tpp/> |

The SHA-256 of the API description as read is
`7781c30e8d925263c525a9ae4e13bce494eb8f695c0f142655420ad02f31d4eb`. When the description changes, compare the
schemas named below with `src/enablebanking/api.ts` and the error codes with `ERROR_CODES` in `src/errors.ts`.

## Endpoints

| Endpoint | Standalone | Gateway | Mark |
|---|---|---|---|
| `GET /application` | `EnableBankingClient.getApplication` (no tool) | `application()` helper | 0.7.0 |
| `GET /aspsps` | `enablebanking_list_banks` | `listBanks()` helper | before; every country, both customer types, sign-in methods, required headers, group and beta flag in 0.7.0 |
| `POST /auth` | `enablebanking_start_consent` | `startAuthorization()` helper | before; sign-in method, account selection, access flags and personal customers in 0.7.0 |
| `POST /sessions` | `enablebanking_complete_consent` | `completeSession()` helper | before; "no accounts" as its own result in 0.7.0 |
| `GET /sessions/{session_id}` | every read, `enablebanking_refresh_consent`, `enablebanking_get_consent_status` | every tool call, `sessionStatus()` helper | before; bank, customer type, times and access in 0.7.0 |
| `DELETE /sessions/{session_id}` | `enablebanking_revoke_consent`, and on renewal | `endSession()` helper | before; an already ended session counts as ended in 0.7.0 |
| `GET /accounts/{account_id}/details` | `enablebanking_get_account_details`, the IBAN check of each account | `get_account_details`, `list_accounts` (only for accounts the host knows nothing about) | before (standalone); a tool of its own on the gateway in 0.7.0 |
| `GET /accounts/{account_id}/balances` | `enablebanking_get_balances` | `get_balances` | before |
| `GET /accounts/{account_id}/transactions` | `enablebanking_list_transactions`, `_summarize_transactions`, `_search_transactions` | `list_transactions`, `summarize_transactions`, `search_transactions` | before; `strategy`, truthful "there is more", summaries and search in 0.7.0 |
| `GET /accounts/{account_id}/transactions/{transaction_id}` | `enablebanking_get_transaction_details` | `get_transaction_details` | 0.7.0 |
| `POST /payments` | none | none | n/a |
| `GET /payments/{payment_id}` | none | none | n/a |
| `DELETE /payments/{payment_id}` | none | none | n/a |
| `POST /payments/{payment_id}/submit` | none | none | n/a |
| `GET /payments/{payment_id}/transactions/{transaction_id}` | none | none | n/a |

There is no client method, endpoint entry or tool for any `/payments` path. Tests assert this for both surfaces.

## Request headers

| Header | Mark | What is done |
|---|---|---|
| `Authorization: Bearer <JWT>` (RS256, `kid` = application id) | before | Signed per request, valid for ten minutes on the gateway and an hour standalone (the API accepts at most 24 hours), never logged. |
| `Psu-Ip-Address`, `Psu-User-Agent`, `Psu-Referer`, `Psu-Accept`, `Psu-Accept-Charset`, `Psu-Accept-Encoding`, `Psu-Accept-Language`, `Psu-Geo-Location` | 0.7.0 (gateway) | Sent on reads at the bank (details, balances, transactions) only when the host passes `context.psu`. Never invented, never sent on session calls. See "Who is present" below. |
| The same headers, standalone | no | The standalone server answers a model, not a browser: it has no address or browser details of a person, and inventing them would misstate presence to the bank. Every standalone read is a background read. |

### Who is present

Enable Banking decides whether a read is made "online" or "in the background" by the presence of `Psu-*` headers:
one header is enough to mark a person as present, and the FAQ recommends sending as many as the application has,
with `Psu-Ip-Address` and `Psu-User-Agent` the two a bank is most likely to require. A bank lists the headers it
requires in `required_psu_headers` (`GET /aspsps`); a read must carry all of them or none, otherwise the API answers
422 `PSU_HEADER_NOT_PROVIDED`. The FAQ's rule for which case applies: when the application itself triggers the read
(a schedule), send none; when a person triggers it, send that person's headers.

The gateway follows this exactly:

- `context.psu` (at least one field) marks the call as asked for by a person and sends the given fields. Anything
  malformed (`null`, an empty object, an unknown field, a value that is not a string, a value with a line break or
  another control character, non-ASCII, more than 512 characters, an IP address that is not one) refuses the call
  with `presence_incomplete` before any request. Each value is checked as given, before anything is trimmed. A
  malformed statement is never turned into a background read.
- The values are sent to the bank and removed from the call's finished result and error texts, so a bank that
  repeats them does not hand them on. The address and the location: always, where the value stands whole, in any
  percent-, JSON- or HTML-encoding up to three layers and in another spelling that says the same. The other
  values: best effort, from 8 characters. A value the bank has changed or cut up over several fields is not
  removed, and the removal is no promise of anonymity. The README has the exact wording.
- `context.unattended: true` marks the call as made with nobody present: no header is sent, and the call counts
  against the budget for unattended reads.
- Neither: no header is sent and no budget is kept, as in 0.6.x.
- Both: refused with `presence_incomplete`.
- `listBanks()` gives each bank's `requiredPsuHeaders`, so a host knows what it must collect.

Open question for the vendor (see the list at the end): whether a question a person asks through an AI assistant
counts as that person being online, and which address and user agent are the right ones to send then. Until that is
answered, a host should send only details it has observed from that person's own device for that request.

## Query parameters of `GET /accounts/{account_id}/transactions`

| Parameter | Mark | What is done |
|---|---|---|
| `date_from`, `date_to` | before | From the tool's `from`/`to`; default the last 30 days including today; at most 366 days per call. |
| `transaction_status` | before | `BOOK` for booked, `PDNG` for pending, none for all. The answer is filtered again by each line's own status, because a bank may ignore the parameter. |
| `continuation_key` | before | Followed until the API gives none. An empty page with a key is continued, and every page of one read is asked for with identical parameters, as the reference requires. |
| `strategy` (`default`, `longest`) | 0.7.0 | `strategy: "longest"` on `list_transactions`. The API ignores `date_to` with it, so `to` is refused and the answer has `to: null`. |

Paging has a fixed upper bound on every path, and the answer says when the bound stopped the read:

| Read | Bound | How "there is more" is told |
|---|---|---|
| Gateway `list_transactions` | 5 pages or 1,000 lines per call | `hasMore: true` and `nextPageToken` (opaque, kept 15 minutes, bound to consent, account, period, status and strategy) |
| Gateway `summarize_transactions` | 20 pages or 5,000 lines | `complete: false`; the text says the totals cover only the lines read |
| Gateway `search_transactions` | 10 pages or 2,500 lines per account, at most 10 accounts | `complete: false`, and per account `complete` |
| Standalone, every transaction read | 50 pages | `complete: false`; `truncated` and `nextOffset` tell a long answer from an incomplete read |

## Bank data: `Transaction`

| Field | Mark | Shown as |
|---|---|---|
| `entry_reference` | before | `entryReference`, and `reference` (falls back to the details id) |
| `transaction_id` | 0.7.0 | `detailsId`, the input of `get_transaction_details`. The reference says it may change between reads; `entry_reference` is the stable one. |
| `transaction_amount` | before | `amount` as a signed decimal string in the bank's precision, `currency` |
| `credit_debit_indicator` | before | `direction` (`in`/`out`) and the sign of `amount` |
| `status` (`BOOK`, `PDNG`, `HOLD`, `SCHD`, `CNCL`, `RJCT`, `OTHR`) | before; all values in 0.7.0 | `status`. `PDNG`, `HOLD` and `SCHD` are "pending"; `CNCL`, `RJCT` and `OTHR` appear only with status `all`. |
| `booking_date`, `value_date` | before | `bookingDate`, `valueDate` |
| `transaction_date` | 0.7.0 | `transactionDate` |
| `creditor`, `debtor` (`name`) | before | `counterparty`: the other side of the line |
| `creditor`, `debtor` (`postal_address`, `organisation_id`) | 0.7.0 | `counterpartyAddress`, `counterpartyOrganisationId` |
| `creditor`, `debtor` (`private_id`, `contact_details`) | no | Personal identifiers, phone numbers and e-mail addresses of other people are not needed to recognise a line and are not passed on. |
| `creditor_account`, `debtor_account` | before | `counterpartyIban`; other schemes in `counterpartyAccounts` (0.7.0). A card number (`CPAN`) is masked to its last four digits. |
| `creditor_account_additional_identification`, `debtor_account_additional_identification` | 0.7.0 | `counterpartyAccounts` |
| `creditor_agent`, `debtor_agent` | 0.7.0 | `counterpartyBank` (BIC, name, clearing system and member id) |
| `remittance_information` | before | `remittance` (each line) and `text` (joined) |
| `reference_number`, `reference_number_schema` | 0.7.0 | `referenceNumber`, `referenceNumberSchema`; the number is also part of `text` |
| `bank_transaction_code` (`description`, `code`, `sub_code`) | before as one text; 0.7.0 in full | `bankCode` and `bankTransactionCode` |
| `merchant_category_code` | 0.7.0 | `merchantCategoryCode` |
| `exchange_rate` (`unit_currency`, `exchange_rate`, `rate_type`, `contract_identification`, `instructed_amount`) | 0.7.0 | `exchangeRate` |
| `balance_after_transaction` | 0.7.0 | `balanceAfter`, `balanceAfterCurrency` |
| `note` | 0.7.0 | `note` |

A field the bank did not give is left out or `null`. Nothing is derived, guessed or filled in per line. A value
that is not text where the description says text is dropped rather than shown.

## Bank data: `BalanceResource`

| Field | Mark | Shown as |
|---|---|---|
| `balance_type` (`CLAV`, `CLBD`, `FWAV`, `INFO`, `ITAV`, `ITBD`, `OPAV`, `OPBD`, `OTHR`, `PRCD`, `VALU`, `XPCD`) | before for a few; all with their meaning in 0.7.0 | `code`, and `type` as "code — meaning" |
| `balance_amount` | before | `amount` (decimal string), `currency` |
| `name` | 0.7.0 | `name` |
| `reference_date` | before | `referenceDate` |
| `last_change_date_time` | 0.7.0 | `lastChange` |
| `last_committed_transaction` | 0.7.0 | `lastCommittedTransaction` |

Each balance answer also has `fetchedAt`: when the bank was read, also for an answer from a cache. The API has no
historic balances, so there is no balance "as of" a date; `balanceAfter` on a line is the only history a bank gives.

## Bank data: `AccountResource`

| Field | Mark | Shown as |
|---|---|---|
| `account_id` (`iban`, `other`) | before (IBAN); other schemes in 0.7.0 | `identifiers`; in listings a masked IBAN or `identification: { scheme, masked }` |
| `all_account_ids` | 0.7.0 | `identifiers` |
| `account_servicer` | 0.7.0 | `servicer` |
| `name` | before | `holderName` (the reference defines it as the account owner's name) |
| `details` | 0.7.0 | `description` |
| `usage` (`PRIV`, `ORGA`) | 0.7.0 | `usage: { code, meaning }` |
| `cash_account_type` (`CACC`, `CARD`, `CASH`, `LOAN`, `OTHR`, `SVGS`) | 0.7.0 | `cashAccountType: { code, meaning }` |
| `product` | before | `product` |
| `currency` | before | `currency`; `XXX` is a multi-currency account: `multiCurrency: true` |
| `psu_status` | 0.7.0 | `holderRole` |
| `credit_limit` | before | `creditLimit` |
| `postal_address` | 0.7.0 | `postalAddress` |
| `uid` | before | The account id of the gateway; never shown by the standalone server, which names accounts by registry id. |
| `identification_hash` | before (0.6.1) | Given by the consent helpers so a host can recognise an account when a consent is renewed. Not in any tool answer. |
| `identification_hashes` | no | The single hash is enough to recognise an account; the list adds hashes of the other identifiers of the same account. |
| `legal_age` | no | A fact about a person that no bank question in scope needs. |

Totals are kept per currency and never added across currencies. No currency is assumed: an account whose currency
neither the bank nor the registry states has `currency: null`.

## Bank list: `ASPSPData`

| Field | Mark | Shown as |
|---|---|---|
| `name`, `country` | before | The identity of a bank is the pair, as the reference says |
| `bic` | before | `bic` |
| `logo` | 0.7.0 (gateway) | `logoUrl`, https only |
| `psu_types` | before | `psuTypes` |
| `maximum_consent_validity` | before | Days, and seconds on the gateway |
| `beta` | before | `beta` |
| `auth_methods` (`name`, `title`, `psu_type`, `approach`, `hidden_method`, `credentials`) | 0.7.0 | `authMethods`; of each credential only `name`, `title` and `required` |
| `required_psu_headers` | 0.7.0 | `requiredPsuHeaders` (only names of the eight documented headers) |
| `group` | 0.7.0 | `group` (the name) |
| `sandbox` | 0.7.0 (gateway) | `sandbox: true/false`. The sandbox users with their passwords are not passed on. |
| `payments` | n/a | Payment types; not read |

`GET /aspsps` is asked with `service=AIS`, and with `country` and `psu_type` only when given. No country is the
default any more.

## Consent: `POST /auth`, `POST /sessions`, `GET /sessions/{session_id}`

| Field | Mark | What is done |
|---|---|---|
| `access.valid_until` | before | Checked against the bank's maximum; default the maximum (90 days when the bank states none) |
| `access.accounts` | 0.7.0 (gateway) | `startAuthorization({ accounts })`: IBANs (checksum checked) or scheme and identification, at most 50 |
| `access.balances`, `access.transactions` | 0.7.0 (gateway) | Optional flags on `startAuthorization`, left to the API's default when not given; the standalone server always leaves them to the default. What a consent ended up covering is shown as `access` on both surfaces. |
| `access.transactions_extended_history` | 0.7.0 | `extendedHistory` on both surfaces |
| `aspsp`, `state`, `redirect_url`, `psu_type`, `language` | before | As given; `psu_type` personal as well as business |
| `auth_method` | 0.7.0 | Must be one the bank offers to that kind of customer; refused before `POST /auth` otherwise |
| `credentials`, `credentials_autosubmit` | no | Bank sign-in credentials of a person. They must not pass through a model, a tool argument or a host log; the person enters them on the bank's page. A bank that cannot be reached without them is not supported. |
| `psu_id` | no | A stable identifier of the person at the vendor. Not needed for one consent per company and bank; it would tie people to consents at a third party. |
| Response `url` | before | Returned to the person to open |
| Response `authorization_id` | 0.7.0 (gateway) | `authorizationId`, for the host's own records |
| Response `psu_id_hash` | no | Follows from `psu_id` |
| `POST /sessions` `code` | before | Exchanged once; never logged |
| Session `status` (`AUTHORIZED`, `CANCELLED`, `CLOSED`, `EXPIRED`, `INVALID`, `PENDING_AUTHORIZATION`, `RETURNED_FROM_BANK`, `REVOKED`) | before | Only `AUTHORIZED` is read from; every other status has its own fixed code |
| Session `accounts`, `accounts_data` | before | Checked on every call: an account the session no longer holds is refused |
| Session `aspsp`, `psu_type`, `access`, `created`, `authorized`, `closed` | 0.7.0 | `sessionStatus()`, `list_accounts.consent`, `enablebanking_get_consent_status` |

A session cannot be prolonged: when it ends, a person signs in at the bank again, and the new session has a new id
and new account ids. `identificationHash` is the same for the account in both. A session may end before
`valid_until`; the server therefore reads the session on every call and decides by the answer, not by the date alone.

A consent that the bank completed but that holds no readable account is a result of its own
(`completeSession().outcome === 'no_accounts'`), not an error and not a connected consent.

## Application: restricted production mode

A production application that is not yet activated works in restricted mode: the API serves only accounts linked to
the application in the control panel. `GET /application` has no field that says "restricted" (`active` is the
closest), so the states are told apart by what the API answers:

| What happens | What the server reports |
|---|---|
| No account is linked at all: `NO_ACCOUNTS_ADDED` (403) | `application_restricted` |
| The person consents to accounts of which none is linked: the session has no accounts | `completeSession().outcome === 'no_accounts'` (gateway); the consent is revoked and reported (standalone) |
| Some of the consented accounts are linked: the session holds only those | The consent is connected with the accounts it holds; nothing is reported about the others, because the API does not name them |
| The application is not allowed the service, the address or the key: `ACCESS_DENIED`, `UNAUTHORIZED_ACCESS`, `UNAUTHORIZED_IP` | `application_refused`. This is never reported as an ended consent. |

## Error codes

Enable Banking's `ErrorCode` list, and the fixed code this server gives each. The fixed code decides, not the HTTP
status: a bare 401 or 403 without a documented code is `access_refused`, never an ended consent.

| Enable Banking code | Fixed code | Meaning for the caller |
|---|---|---|
| `EXPIRED_SESSION` | `consent_expired` | The consent ran out; a person must sign in at the bank again |
| `REVOKED_SESSION`, `CLOSED_SESSION` | `consent_revoked` | The consent was ended, by the person or by the application |
| `SESSION_DOES_NOT_EXIST`, `WRONG_SESSION_STATUS` | `consent_not_active` | There is no usable consent under that id |
| `ACCOUNT_DOES_NOT_EXIST` | `account_not_in_consent` | The consent does not hold that account |
| `ASPSP_ACCOUNT_NOT_ACCESSIBLE` | `account_not_accessible` | The bank does not let this person read that account |
| `ASPSP_ERROR`, `ASPSP_TIMEOUT` (and 5xx) | `bank_unavailable` | The bank did not answer properly; try later (the vendor suggests after 1 minute, then 1, 2 and 4 hours) |
| `ASPSP_RATE_LIMIT_EXCEEDED` (and 429) | `rate_limited`, `retryAfterSeconds: 21600` | The bank's limit is reached; the vendor recommends waiting six hours |
| `ASPSP_PSU_ACTION_REQUIRED` | `person_action_required` | The person must do something at the bank first |
| `WRONG_TRANSACTIONS_PERIOD` | `period_not_available` | The bank does not give that period (often only 90 days back once the first hour after sign-in has passed) |
| `DATE_FROM_IN_FUTURE`, `DATE_TO_WITHOUT_DATE_FROM`, `WRONG_DATE_INTERVAL` | `invalid_period` | Checked before the request, so these are not expected from the API |
| `PSU_HEADER_NOT_PROVIDED`, `PSU_HEADER_INVALID` | `presence_incomplete` | The bank requires more, or other, details of the person present |
| `TRANSACTION_DOES_NOT_EXIST` | `transaction_not_found` | No such transaction; the details id may have changed since the listing |
| `ACCESS_DENIED`, `UNAUTHORIZED_ACCESS`, `UNAUTHORIZED_IP`, `AUTHORIZATION_NOT_PROVIDED`, `INVALID_HOST` | `application_refused` | The application is refused. The consent is not the cause. |
| `NO_ACCOUNTS_ADDED` | `application_restricted` | Restricted mode with no linked account |
| `WRONG_CONTINUATION_KEY` | `page_token_invalid` | Start the listing again |
| `WRONG_REQUEST_PARAMETERS`, `INVALID_ACCOUNT_ID` | `invalid_input` | The request was not accepted as written |
| `WRONG_ASPSP_PROVIDED`, `WRONG_CREDENTIALS_PROVIDED`, `REDIRECT_URI_NOT_ALLOWED`, `ALREADY_AUTHORIZED`, `EXPIRED_AUTHORIZATION_CODE`, `WRONG_AUTHORIZATION_CODE` | by HTTP status (`upstream_error` for a 4xx that is not 401, 403, 404, 408 or 429) | Errors of the consent flow; the helper's message names the Enable Banking code |
| `PAYMENT_*`, `INVALID_PAYMENT`, `UNTRUSTED_PAYMENT_PARTY`, `ASPSP_PAYMENT_NOT_ACCESSIBLE`, `WEBHOOK_URI_NOT_ALLOWED` | n/a | Payment initiation |

Fixed codes of the server's own refusals: `no_consent`, `account_not_connected` (not one of the company's accounts:
the registry or the host's list says no), `unattended_limit`, `invalid_input`, `invalid_period`,
`page_token_invalid`, `presence_incomplete`, `no_accounts`, `not_found`, `upstream_error`.

The exact mapping is `problemFromHttp` in `src/enablebanking/problems.ts`; `test/limits.test.ts` and
`test/gateway-coverage.test.ts` pin it. Enable Banking's own message text is never passed on, only its code.

## Limits

| Limit | Source | What is done |
|---|---|---|
| Reads with nobody present | FAQ: "many ASPSPs have the limit of 4 times a day" for background reads | Gateway: a call marked `unattended` counts against a budget of 4 reads at the bank per consent in any 24 hours (`unattendedFetchesPerDay`, 0 turns it off). When it is used up the call is refused with `unattended_limit` and the time of the next possible read, before any request. A listing from the consent data costs nothing. Standalone: the same budget, off unless `ENABLEBANKING_UNATTENDED_FETCHES_PER_DAY` is set. |
| The bank's own rate limit | 429 `ASPSP_RATE_LIMIT_EXCEEDED`; FAQ: continue after 6 hours | `rate_limited` with `retryAfterSeconds: 21600`; unattended reads of that consent pause for six hours, also when the limit shows up for one account inside a search, and also for the next page of a listing; a search does not ask for the remaining accounts |
| Transaction history | Reference and FAQ: full history for about an hour after sign-in, then often 90 days | `period_not_available` with that explanation; `strategy: "longest"` asks for as much as the bank gives |
| Consent length | `maximum_consent_validity` per bank, at most 180 days for most | Shown per bank; days left in `list_accounts` and the consent status |
| Caching | none required | Standalone: 300 seconds by default (`ENABLEBANKING_CACHE_SECONDS`), per account of one consent, reached only after the registry and the stored consent have been checked on that call. Once any answer from Enable Banking says a consent is over or an account has left it (a failed read, the consent status, a refresh), what was read under it is dropped and it is not read until it is seen in order again. Gateway: none; see below. |

### No answer cache in the gateway

A draft of 0.7.0 had an opt-in cache of finished answers in the gateway. It was taken out before release: a kept
answer could be returned after the session had stopped covering one of its accounts, and making that certain for
every tool was not a small change. The gateway now keeps no bank data between calls, and what a call returns is
decided by that call alone. With `credentials.accounts`, listing accounts needs no read at the bank; a person who
asks is not limited; and the budget keeps unattended reads within the bank's limit, so little is lost.

The standalone server keeps its cache: it has no person to send details of, so every read it makes is a background
read on the bank's four a day, and answering the same question twice from memory is what makes it usable. Its rule
and every way it learns that a consent is over are in the README ("What the cache may answer") and in
`test/standalone-authority.test.ts`.

A cache added to the gateway later must hold all of this, with a test for each:

1. An answer is returned only if every account it holds is in the session's accounts as read on this call, and in
   the `accountIds` given with this call.
2. It is keyed by the consent, the tool, the input and the accounts of the call, and is never returned for another
   consent. A consent that ends, is replaced or is closed drops its answers at once.
3. It is stored after the call's redaction, the details of the person present included, never before.
4. An error, and an answer that holds a failure for any account, is never stored.
5. It never stands in for the session check, the account check or the budget's pause after a rate limit.

What the limit of four counts (per consent, per account or per endpoint) is not stated by the vendor and varies by
bank. The budget counts one for each account a call reads at the bank, which is the cautious reading.

## Countries and banks

Nothing in the read path is specific to a country: accounts are named by any identification scheme, amounts keep
the bank's currency and precision, and banks are listed for every country the application covers. The standalone
account registry still describes companies in a Danish shape (registration number, IBAN only); accounts without an
IBAN are served on the gateway path only. See the changelog of 0.7.0 for what remains.

## Not covered, in one place

| What | Why |
|---|---|
| Payment initiation (all `/payments` paths, `ASPSPData.payments`, payment error codes) | Out of scope by design: this server cannot pay or move money. A design for a separate module is in [payment-initiation-design.md](payment-initiation-design.md). |
| `credentials`, `credentials_autosubmit` on `POST /auth` | Bank sign-in credentials must not pass through a model or a host |
| `psu_id`, `psu_id_hash` | Not needed; would identify people at the vendor |
| `private_id`, `contact_details` of counterparties; `legal_age` of the holder | Personal data no bank question in scope needs |
| `identification_hashes` | The single hash is enough |
| Sandbox users (`ASPSPData.sandbox.users`) | Test credentials; only whether the bank is a sandbox bank is passed on |
| `Psu-*` headers on the standalone server | It has no real details of a person to send |
| Webhooks | Documented for payments only; account information has none |
| Widgets (the vendor's bank-selection page elements) | Front-end components; a host builds its own page from `listBanks()` |
| The control panel (applications, linked accounts, mock bank data) | Has no API; done by a person in the browser |

## Questions for the vendor

1. Is a question that a person asks through an AI assistant "PSU online"? If so, which IP address and user agent
   should be sent: those of the person's device as seen by the host, or none when the host has not observed them?
2. What does the limit of four background reads count at each Danish bank: reads per consent, per account, or per
   account and endpoint? Do details, balances and transactions count separately?
3. Is there a way to see from the API that an application is in restricted mode, and which accounts are linked?
4. Can a sandbox authorisation with the mock bank be completed without a browser, for an unattended nightly test?
5. Does `GET /sessions/{session_id}` ever count as a read at the bank? (This server assumes it does not.)
