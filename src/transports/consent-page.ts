import type { ServerResponse } from 'node:http';
import { writeAuditEvent } from '../enablebanking/audit.js';
import { ConsentError, type Bank, type BindingReport } from '../enablebanking/bank.js';
import type { EnableBankingConfig } from '../enablebanking/config.js';
import { maskIban } from '../enablebanking/registry.js';

/** The path the bank's redirect arrives on, when this server completes consents itself. */
export function consentCallbackPath(config: EnableBankingConfig): string | undefined {
  if (!config.consentEnabled || !config.consentCallback || !config.redirectUrl) return undefined;
  return new URL(config.redirectUrl).pathname;
}

/**
 * GET <callback path>?code=…&state=… from the bank (via the user's browser).
 * The URL is rebuilt on the configured redirect origin, never from the Host
 * header. Errors that are the user's to fix are shown; anything else is not.
 */
export async function handleConsentCallback(
  bank: Bank,
  config: EnableBankingConfig,
  requestUrl: string,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(requestUrl, config.redirectUrl);
  const company = bank.companyInfo().name;
  try {
    const { report, user } = await bank.completeConsentCallback(url.toString());
    await writeAuditEvent(config.auditLog, {
      company: bank.company,
      actingAs: user,
      tool: 'consent_callback',
      action: 'finish',
      reason: `bound ${report.bound.length}`,
    }).catch(() => undefined);
    sendConsentPage(res, 200, { company, report, returnUrl: config.returnUrl });
  } catch (error) {
    const known = error instanceof ConsentError;
    await writeAuditEvent(config.auditLog, {
      company: bank.company,
      actingAs: 'unknown',
      tool: 'consent_callback',
      action: 'error',
      error: known ? error.message : 'internal error',
    }).catch(() => undefined);
    if (!known) console.error(error);
    sendConsentPage(res, known ? 400 : 500, {
      company,
      error: known ? error.message : 'Noget gik galt ved forbindelsen til banken.',
      returnUrl: config.returnUrl,
    });
  }
}

/**
 * The page the bank's redirect lands on when the server completes the consent
 * itself (ENABLEBANKING_CONSENT_CALLBACK). It shows what was bound and never
 * the code or state; nothing on it is script.
 */
export function sendConsentPage(
  res: ServerResponse,
  status: number,
  page: { company: string; report?: BindingReport; error?: string; returnUrl?: string },
): void {
  const title = page.error ? 'Samtykket blev ikke gennemført' : 'Samtykke gennemført';
  const body = page.error ? errorBody(page.error) : successBody(page.company, page.report!);
  const back = page.returnUrl
    ? `<p><a class="button" href="${escapeHtml(page.returnUrl)}" rel="noreferrer">Tilbage til Claude</a></p>`
    : '<p class="muted">Du kan lukke denne fane og gå tilbage til Claude.</p>';
  const html = `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --ok: #1f7a3a; --err: #a4262c; --line: #e3e3de; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201e; --text: #ecece8; --muted: #a3a39c; --ok: #5cc27d; --err: #ef7a80; --line: #33332f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
h1.ok { color: var(--ok); } h1.err { color: var(--err); }
ul { padding-left: 1.2rem; } li { margin: .2rem 0; }
code { font-size: .9em; }
.muted { color: var(--muted); }
.button { display: inline-block; padding: .6rem 1rem; border-radius: 8px; background: var(--text); color: var(--card); text-decoration: none; }
</style>
</head>
<body><main><div class="card">
<h1 class="${page.error ? 'err' : 'ok'}">${escapeHtml(title)}</h1>
${body}
${back}
</div></main></body>
</html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

function successBody(company: string, report: BindingReport): string {
  if (report.bound.length === 0) {
    return `<p>${escapeHtml(report.bank)} gav adgang, men ingen af kontiene er registreret til <strong>${escapeHtml(company)}</strong>.
Samtykket er derfor tilbagekaldt igen, og intet kan læses.</p>${extras(report)}`;
  }
  const accounts = report.bound
    .map(account => `<li>${escapeHtml(account.name)} <code>${escapeHtml(maskIban(account.iban))}</code></li>`)
    .join('');
  return `<p><strong>${escapeHtml(company)}</strong> er forbundet til ${escapeHtml(report.bank)}${validity(report.validUntil)}. Disse konti kan nu læses:</p>
<ul>${accounts}</ul>${extras(report)}`;
}

function extras(report: BindingReport): string {
  const notes: string[] = [];
  if (report.otherCompany.length) notes.push(`${report.otherCompany.length} konto(er) tilhører et andet selskab og blev ikke tilknyttet.`);
  if (report.unregistered.length) notes.push(`${report.unregistered.length} konto(er) er ikke registreret til noget selskab; spørg Claude (enablebanking_list_accounts) om detaljer.`);
  if (report.registeredButNotInConsent.length) notes.push(`${report.registeredButNotInConsent.length} registreret konto(er) var ikke med i samtykket.`);
  return notes.length ? `<p class="muted">${notes.map(escapeHtml).join('<br>')}</p>` : '';
}

function validity(validUntil: string): string {
  const date = new Date(validUntil);
  return Number.isNaN(date.getTime()) ? '' : ` til og med ${escapeHtml(date.toISOString().slice(0, 10))}`;
}

function errorBody(message: string): string {
  return `<p>${escapeHtml(message)}</p><p class="muted">Bed Claude om at starte samtykket igen (enablebanking_start_consent).</p>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
