# Payment initiation: design note

This server does not initiate payments, and nothing in this note is implemented. There is no payment tool, client
method, endpoint entry or type in the code, and tests assert that. The note records what Enable Banking's API
offers for payment initiation, how it could be added safely as a separate module, and what must be settled with the
vendor first.

Sources and the date read are listed in [capability-map.md](capability-map.md).

## Conclusion

Do not build it yet. Three things stand in the way, in this order:

1. **Licence.** The API reference states that in production "payment initiation functionality is only available to
   companies holding a PISP license". An operator without that licence cannot offer payments through this API,
   whatever the code does. The vendor's "TPP infrastructure as a service" is for companies that already hold a
   licence. Whether there is any route for an unlicensed operator is the first question to the vendor.
2. **Who confirms.** A payment is confirmed by a person at the bank, with the bank's strong customer authentication.
   That part is sound and outside the model's reach. What is not given is that the person sees, at the bank, exactly
   the payment that was prepared. The design below closes that gap, and it needs a browser page of the host between
   the model and the bank.
3. **No undo.** The API has no refund and no cancellation of an executed payment. `DELETE /payments/{payment_id}`
   removes a finished or failed payment from the vendor's records; it does not return money.

If the licence question is answered, the module below is small: three tools, one host page and a status poll.

## What the API offers

### Endpoints

| Endpoint | What it does |
|---|---|
| `POST /payments` | Creates a payment of one or more credit transfers and returns the address of the bank's authorisation page, and a `payment_id` |
| `GET /payments/{payment_id}` | The payment as it stands: `status`, `final_status`, `status_reason_information`, `payment_details` (after authorisation also the debtor's name and account) |
| `POST /payments/{payment_id}/submit` | Sends an authorised payment for execution, when it was created with `defer_submission: true` |
| `GET /payments/{payment_id}/transactions/{transaction_id}` | The status of one transfer of a bulk payment |
| `DELETE /payments/{payment_id}` | "Delete finished or failed payment" (`PAYMENT_NOT_FINALIZED` otherwise). Not a cancellation. |
| `GET /aspsps?service=PIS` | Per bank and customer type, the payment types it supports and the rules of each |

### Payment types

`PaymentType`: `SEPA`, `INST_SEPA` (instant, no fallback), `DOMESTIC`, `CROSSBORDER`, `INTERNAL` (within one bank),
the Polish and Swedish domestic schemes (`DOMESTIC_PL_*`, `DOMESTIC_SE_GIRO`), and the bulk types `BULK_SEPA`,
`BULK_DOMESTIC` and `BULK_DOMESTIC_SE_GIRO`.

- **Single**: one `credit_transfer_transaction`.
- **Bulk**: several transfers in one payment with a `BULK_` type, authorised by the person once. Each transfer gets
  a `transaction_id` and its own status. `max_transactions` per bank and type gives the limit.
- **Future-dated**: `requested_execution_date`, when the bank's payment type has
  `requested_execution_date_supported`, up to `requested_execution_date_max_period` days ahead.
- **Periodic (standing orders)**: the transfer has `frequency` (`DAIL`, `WEEK`, `TOWK`, `MNTH`, `TOMN`, `QUTR`,
  `SEMI`, `YEAR`), `end_date` and `execution_rule` (`FWNG`, `PREC`). The description defines the fields; which
  banks accept them is not stated per bank in the bank list, so it must be asked or tested.

What a given bank accepts is in its `payments` list (`ResponsePaymentType`): currencies, account schemes for debtor
and creditor, whether the debtor account must be given or is chosen by the person at the bank, the allowed sign-in
methods, charge-bearer values, reference-number schemes, remittance line lengths, which creditor details are
required, the customer type it applies to, the statuses that count as final, and
`deferred_submission_supported`.

### Denmark

From the vendor's page on Denmark: all Danish banks support domestic credit transfers in DKK and SEPA credit
transfers in EUR; accounts in EUR are uncommon, and some banks do not allow a SEPA payment from an account held in
DKK. Authorisation is by redirect with MitID for nearly all banks; a domestic payment may be confirmable in the
bank's mobile app while a SEPA payment needs MitID. The banks named as the most used are Danske Bank, Nordea (with
separate "brands" for its business systems), Jyske Bank, Sydbank, Nykredit Bank, Spar Nord Bank and Arbejdernes
Landsbank.

Which payment types each of these offers to business and to personal customers is not in the prose. It is the
answer of `GET /aspsps?service=PIS&country=DK`, which needs an application and was therefore not read for this
note. That list is the first thing to capture once there is a sandbox application.

### The flow

1. The application sends `POST /payments` with `payment_type`, `payment_request`, the bank, `psu_type`, a `state`
   and a `redirect_url`.
2. The API answers with a `url`. The person opens it, signs in at the bank and approves the payment with the bank's
   strong customer authentication.
3. The bank sends the person back to `redirect_url` with the `state`.
4. By default the vendor submits the payment for execution as soon as the person has approved it. With
   `defer_submission: true` it waits for `POST /payments/{payment_id}/submit`; in between,
   `GET /payments/{payment_id}` shows the debtor's name and account as the bank gave them. The FAQ names this as
   the purpose: check that the account holder is the expected one before money moves. An authorised payment that is
   never submitted is not executed.
5. The application polls `GET /payments/{payment_id}` until `final_status` is true, or receives the payment status
   webhook (`webhook_url` on the request; the origin must be allowed in the control panel; each call carries a
   signed token to verify and must be acknowledged within 10 seconds).

### Statuses

`PaymentStatus` follows ISO 20022: `RCVD` (received), `PDNG` (pending), `ACTC` (technical validation passed),
`ACCP` (customer profile check passed), `ACWC` (accepted with a change), `ACSP` (settlement in process), `ACWP`
(accepted without posting), `ACSC` (settled on the debtor's account), `ACCC` (settled on the creditor's account),
`PART` (partially accepted, bulk), `ACPT` (accepted), `RJCT` (rejected), `CNCL` (cancelled), and the cancellation
request statuses `ACCR`, `RJCR`, `PACR`, `PDCR` and `NULL`.

`final_status` says whether the payment has reached a status the bank's payment type counts as final. The FAQ adds
a warning that belongs in any tool text: a final status does not guarantee that the money reaches the creditor;
the application must judge that itself.

### Cancel and refund

- There is no endpoint that cancels a payment after the person has approved it. The cancellation statuses exist in
  the list, but the API description has no request that starts a cancellation.
- Before approval, a payment that the person abandons is never executed. With deferred submission, an approved
  payment that is not submitted is not executed either.
- There is no refund endpoint. Money sent to the wrong party is recovered outside the API, between the parties or
  through the bank.

## A safe design

A separate package entry (for example `mcp-server-enablebanking/payments`), not part of the account information
gateway and not registered by the standalone server unless explicitly enabled. The account information surface
stays exactly as it is: no payment code path is reachable from it.

### Principles

1. **Off by default, enabled twice.** The operator enables the module, and the Enable Banking application must be
   enabled for payments by the vendor. Either alone does nothing.
2. **The model prepares; a person confirms; nothing confirms on the person's behalf.** There is no tool that
   approves, submits or retries a payment.
3. **The person sees the prepared payment on the host's page before the bank's.** The model never receives the
   bank's authorisation address.
4. **The payment is logged before it is sent to the vendor.** If the log cannot be written, it is not sent.
5. **A small, fixed scope first.** One transfer per payment, domestic or SEPA, from an account that is already
   connected for account information, to a creditor given in full. No bulk, no standing orders, no future dates in
   the first version.

### Tools (model-facing)

| Tool | Does | Does not |
|---|---|---|
| `prepare_payment` | Validates the transfer against the bank's `payments` rules (currency, schemes, lengths, required creditor details) and stores a draft with the host. Returns a draft id and a link to the host's confirmation page. | Call `POST /payments`. Return any bank address. |
| `get_payment_status` | Returns the status of a payment that was created from a draft of this company: the vendor's status, whether it is final, and the warning about final statuses. | Change anything. |
| `list_payment_drafts` | Lists drafts and payments of this company with their state. | Show another company's. |

There is deliberately no `confirm_payment`, `submit_payment` or `cancel_payment` tool.

### The host page (not reachable by a model)

1. The person opens the link while signed in to the host. The page shows the draft as stored: debtor account,
   creditor name and account, amount, currency, text, and who prepared it and when.
2. The person presses one button. Only then does the host call `POST /payments` with `defer_submission: true`
   (where the bank supports it), an unguessable single-use `state`, and the host's own `redirect_url`.
3. The host redirects the browser to the vendor's `url`. The person approves at the bank.
4. On return the host checks `state`, reads `GET /payments/{payment_id}` and compares what the bank reports
   (amount, currency, creditor account, and the debtor account, which must be one of the company's connected
   accounts) with the stored draft. Only if every value matches does it call `submit`. Any difference: no submit,
   the draft is marked failed, and the person is told why.
5. The host polls the status until it is final, with a fixed upper bound, and records the result.

Where a bank does not support deferred submission, the payment is executed when the person approves at the bank,
and step 4's comparison is a check after the fact. The first version should therefore offer only banks and payment
types with `deferred_submission_supported: true`.

### What this protects against

| Risk | Protection |
|---|---|
| A bank line, a document or an e-mail tells the model to pay someone | The model can only create a draft; the person reads the draft on a page the model cannot write to, then approves at the bank |
| The model changes amount or creditor after the person looked | The draft is immutable once created; the page shows the stored values; a new draft has a new link |
| The person approves at the bank without reading | The same values are shown twice, on the host's page and at the bank; the comparison before submit catches a mismatch |
| A payment from another company's account | The debtor account must be one the registry or the host's list gives this company, checked at prepare, at create and against the bank's answer before submit |
| Double payment after a timeout | The draft holds the `payment_id` once created; a draft creates at most one payment; the status is read, never re-created |
| Replay of the redirect | Single-use `state` bound to the draft and the signed-in person |
| Leaks | Creditor details and texts are bank data: not logged beyond what the host's audit needs, never in errors |

### Limits to set in the host, not in the model

A maximum amount per payment and per day per company, a list of allowed currencies, and optionally a list of
approved creditors. All checked at prepare and again at create.

## What the vendor requires

Stated in the documentation:

- A PISP licence for payment initiation in production.
- A signed contract and a completed KYB process before a production application is fully active. Pricing is by
  volume (accounts read and payments made per month) with a monthly minimum.
- Production applications must give links to their terms and privacy policy and a data protection e-mail address;
  the vendor checks and monitors them.
- For a licensed provider: its own eIDAS certificates (QWAC and QSealC), a dedicated environment, and its own
  terms shown to the person.
- Webhook origins must be allowed in the control panel; webhook tokens must be verified (signature, key address on
  the vendor's domain, digest of the body).
- The sandbox enables payment initiation for every new application. The mock bank does not offer it; the Nordea and
  VestjyskBank sandboxes do.

Not stated, and to be asked: see below.

## Questions for the vendor

1. Is there any way for a company without a PISP licence to offer payment initiation through your API in
   production, for example as an agent of a licensed provider, or with you as the licensed party? If not, what do
   you recommend for a company that only wants its own customers to pay their own suppliers from their own accounts?
2. For each of the large Danish banks, for business customers: which payment types, currencies and sign-in methods
   are supported, is `deferred_submission_supported` true, and must the debtor account be given or can it be fixed
   by the application so the person cannot choose another?
3. Can the debtor account be restricted to one given account at every Danish bank, so a person cannot pay from an
   account of another company they also have access to?
4. Which banks accept future-dated payments and standing orders (`frequency`, `end_date`, `execution_rule`), and
   how is a standing order stopped afterwards?
5. Is there any way to cancel a payment after authorisation but before execution, other than deferred submission
   that is never submitted? What do the cancellation statuses (`ACCR`, `PDCR` and the others) refer to?
6. What does `UNTRUSTED_PAYMENT_PARTY` mean in practice: is there a list of trusted creditors or debtors per
   application, and who maintains it?
7. What are `PAYMENT_LIMIT_EXCEEDED`'s limits: per payment, per application, per day? Can an application set lower
   limits of its own at your side?
8. How long does a payment stay readable through `GET /payments/{payment_id}`, and what does `DELETE` remove?
9. Are payment status webhooks delivered at least once and in order, and for how long should polling continue when
   `final_status` stays false?
10. What are the price per payment and the monthly minimum when payments are added to an account information
    contract?
