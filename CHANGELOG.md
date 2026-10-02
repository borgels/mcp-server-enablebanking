# Changelog

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
