import { createPrivateKey, type KeyObject } from 'node:crypto';
import type { AccountIdentification, AccountResource, Aspsp, AuthMethod } from './enablebanking/api.js';
import { budgetRefusal, DEFAULT_UNATTENDED_FETCHES_PER_DAY, UnattendedBudget } from './enablebanking/budget.js';
import { isProblemCode, problemOf, PROBLEM_CODES, type ProblemCode } from './enablebanking/problems.js';
import { PSU_HEADER_NAMES, PSU_REFUSED, psuHeaders } from './enablebanking/psu.js';
import { isValidIban, normalizeIban } from './enablebanking/registry.js';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  GatewayClient,
  ID_PATTERN,
  type PresenceHeaders,
} from './gateway/client.js';
import { enableBankingGatewayTools, type GatewayToolDefinition, type GatewayJsonObject, type GatewayJsonValue } from './gateway/catalog.js';
import { EnableBankingHttpError, ERROR_CODES } from './errors.js';
import { failureInForm, failureMetadata } from './gateway/failure.js';
import { FRAGMENT_LENGTH, GatewayRedactor } from './gateway/redact.js';
import { DEFAULT_ENDED_SESSIONS_KEPT, Withdrawals, type CallWatch } from './gateway/withdrawals.js';
import {
  bankReads,
  callCredentials,
  consentAccount,
  consentState,
  errorResult,
  instant,
  NO_CREDENTIALS,
  NOT_ALLOWED,
  NOT_IN_CONSENT,
  PAGE_TOKEN_MISMATCH,
  PAGE_TOKEN_UNKNOWN,
  PageTokens,
  parseCall,
  PRESENCE_CONTRADICTION,
  runTool,
  SESSION_STATUSES,
  WITHDRAWN_MEANWHILE,
  sessionAccess,
  sessionAccountHashes,
  sessionAccounts,
  sessionBank,
  type PageState,
} from './gateway/tools.js';
import type {
  CompleteSessionResult,
  ConsentAccount,
  EnableBankingApplicationStatus,
  EnableBankingAuthMethod,
  EnableBankingBank,
  EnableBankingGatewayOptions,
  EnableBankingReadTargetResolution,
  EndSessionResult,
  GatewayCallContext,
  GatewayToolResult,
  SessionStatusResult,
  StartAuthorizationInput,
  StartAuthorizationResult,
} from './gateway/types.js';
import { fixedOutputs, INPUT_REFUSED, RESULT_WITHHELD, SESSION_REFUSED, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, keyRefusedText, leaksSecret, sealedError, type LeakMatcher } from './key-admission.js';

/**
 * Embeddable entry point: a host that serves many companies from one process
 * (and does its own per-user authorization and logging) lists the tools, reads
 * the catalog, and invokes `callTool` with the company's consent in the call
 * context.
 *
 * - The application's credentials (id and RS256 key) are given once, at
 *   creation. Nothing is read from ENABLEBANKING_* or any other environment
 *   variable on this path.
 * - Each call carries the company's `sessionId` and `accountIds`: the accounts
 *   the company consented to and the host stored. An account outside that list
 *   is refused before any request; the bank session must also still contain it.
 * - Each call can say who is behind it: a person present (`psu`), or nobody
 *   (`unattended`). That decides whether the bank counts the read against its
 *   limit on background reads, and whether the gateway's own daily budget applies.
 * - Read-only: accounts, balances, transactions, and summaries and searches
 *   computed from them. There is no tool, method or endpoint that can move
 *   money anywhere in this surface.
 * - The consent helpers (listBanks, startAuthorization, completeSession,
 *   sessionStatus, endSession, application) are plain functions for the host's
 *   own consent page; they are not tools and an AI client cannot reach them.
 */

export {
  enableBankingGatewayTools,
  enableBankingServiceCatalog,
  enableBankingToolCatalog,
  type EnableBankingDefaultRead,
  type EnableBankingEndpointCatalogEntry,
  type EnableBankingExposure,
  type EnableBankingServiceCatalog,
  type GatewayJsonObject,
  type GatewayJsonValue,
  type GatewayReadonlyJsonValue,
  type GatewayRiskLevel,
  type GatewayToolCatalogEntry,
  type GatewayToolDefinition,
  type GatewayUpstreamOperation,
} from './gateway/catalog.js';

export type {
  CompleteSessionResult,
  ConsentAccount,
  EnableBankingAccountSelection,
  EnableBankingApplicationStatus,
  EnableBankingAuthMethod,
  EnableBankingBank,
  EnableBankingGatewayCredentials,
  EnableBankingGatewayOptions,
  EnableBankingKnownAccount,
  EnableBankingProblemCode,
  EnableBankingPsu,
  EnableBankingReadTarget,
  EnableBankingReadTargetResolution,
  EndSessionResult,
  GatewayCallContext,
  GatewayFailure,
  GatewayToolResult,
  SessionStatusResult,
  StartAuthorizationInput,
  StartAuthorizationResult,
} from './gateway/types.js';

/** Every value `errorCode` (on a result) and `problem` (on a consent helper's error) can have. Frozen. */
export const enableBankingProblemCodes: readonly ProblemCode[] = Object.freeze([...PROBLEM_CODES]);

/** The request header each field of a call's `psu` is sent as. Frozen. */
export const enableBankingPsuHeaders: Readonly<Record<string, string>> = PSU_HEADER_NAMES;

/** Error thrown by the consent helpers. Its message is redacted and carries no cause. */
export class EnableBankingGatewayError extends Error {
  readonly status?: number;
  /** Enable Banking's documented error code, when its answer named one. */
  readonly code?: string;
  /** Our own fixed code for what went wrong (see enableBankingProblemCodes), when it is known. */
  readonly problem?: ProblemCode;
  constructor(message: string, details: { status?: number; code?: string; problem?: ProblemCode } = {}) {
    super(message);
    this.name = 'EnableBankingGatewayError';
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    if (details.problem !== undefined) this.problem = details.problem;
  }
}

const MAX_SELECTED_ACCOUNTS = 50;
const DEFAULT_MAXIMUM_CONSENT_SECONDS = 90 * 86_400;
const STATE_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;
/** An auth method name, an authorisation id and an identifier scheme: plain tokens only. */
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDENTIFICATION_PATTERN = /^[A-Za-z0-9 ._:/-]{1,64}$/;

/**
 * Resolves what a tool call will read, with the same checks callTool applies
 * before any request: known tool, no unknown fields, well-formed account,
 * dates and page token, and a period of at most 366 days. The account
 * allowlist needs the call's credentials and is checked by callTool.
 */
export function resolveEnableBankingReadTarget(
  toolName: string,
  input: GatewayJsonObject = {},
  now: number = Date.now(),
): EnableBankingReadTargetResolution {
  const resolution = parseCall(toolName, input, now);
  return resolution.ok ? { ok: true, target: resolution.target } : { ok: false, reason: resolution.reason, code: resolution.code };
}

/** Who is behind a call: a person (their headers), nobody, or not said. */
type Presence = { kind: 'present'; headers: PresenceHeaders } | { kind: 'unattended' } | { kind: 'unspecified' };

function callPresence(context: GatewayCallContext | undefined): Presence | { kind: 'refused'; reason: string } {
  const psu = (context as { psu?: unknown } | undefined)?.psu;
  const unattended = (context as { unattended?: unknown } | undefined)?.unattended;
  if (unattended !== undefined && typeof unattended !== 'boolean') return { kind: 'refused', reason: PSU_REFUSED };
  // Only a field that is not there at all means "not said". null, like any other malformed value, is refused by
  // psuHeaders: a host's mistake is never read as "nobody is present".
  if (psu !== undefined) {
    if (unattended === true) return { kind: 'refused', reason: PRESENCE_CONTRADICTION };
    const parsed = psuHeaders(psu);
    return parsed.ok ? { kind: 'present', headers: parsed.headers } : { kind: 'refused', reason: PSU_REFUSED };
  }
  return unattended === true ? { kind: 'unattended' } : { kind: 'unspecified' };
}

// ------------------------------------------------------------------ factory

function validateOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('createEnableBankingGateway: apiBaseUrl must be an absolute URL.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (!allowed || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('createEnableBankingGateway: apiBaseUrl must be an https origin without path, query or credentials.');
  }
  return url.origin;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`createEnableBankingGateway: ${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function createEnableBankingGateway(options: EnableBankingGatewayOptions) {
  // Every construction error leaves through a redactor that holds the key, and then the sink check, as the very last
  // step: a fixed text of ours or an option can hold a piece of it.
  const guard = new GatewayRedactor();
  let content = '';
  try {
    const given: unknown = options && typeof options === 'object' ? options.privateKey : undefined;
    if (typeof given === 'string') {
      // Admission of the text before anything is built from it: PEM is printable ASCII with line breaks.
      content = pemContent(given);
      if (!PEM_TEXT.test(given)) throw new Error(KEY_REFUSED);
      guard.addKey(given);
    } else if (given && typeof given === 'object' && (given as KeyObject).type === 'private') {
      // A key that cannot be exported, or exports no content, would leave the instance with no secret to check
      // against: refused. Never run with an empty secret set.
      let pem = '';
      try {
        pem = String((given as KeyObject).export({ type: 'pkcs8', format: 'pem' }));
      } catch {
        pem = '';
      }
      content = pemContent(pem);
      if (!content) throw new Error(KEY_REFUSED);
      guard.addKey(pem);
    }
    const gateway = buildEnableBankingGateway(options);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) throw new Error(keyRefusedText(content));
    return gateway;
  } catch (error) {
    let message = guard.redact(error instanceof Error ? error.message : String(error));
    if (leaksSecret(message, guard)) message = keyRefusedText(content);
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against the key. Then the sink check on the finished object.
    const final = sealedError(new Error(message), content);
    if (leaksSecret(final, guard)) throw sealedError(new Error(keyRefusedText(content)), content);
    throw final;
  }
}

/** What a value a consent helper registers as a secret (state, code, session id) may consist of. */
const PRINTABLE_SECRET = /^[\x21-\x7E]*$/;

/** What a PEM key given as text may consist of. */
const PEM_TEXT = /^[\t\n\r\x20-\x7E]*$/;

/** Whether a session id can be used: admitted like a key, and sharing no piece with a fixed output. */
function sessionAdmitted(sessionId: string): boolean {
  if (!admitsKey(sessionId)) return false;
  const probe = new GatewayRedactor();
  probe.watch(sessionId);
  // The tool list goes to the host too: a session id that shares a piece with it is refused like one that shares a
  // piece with a fallback.
  return !leaksSecret([fixedOutputs(), enableBankingGatewayTools], probe);
}

/**
 * The sink check on a finished error object (name, message, stack, status,
 * code), right before it leaves: one that holds a piece of a secret is
 * replaced by the sealed fixed fallback.
 */
function released<E extends Error>(error: E, check: GatewayRedactor, fallback: () => E): E {
  return leaksSecret(error, check) ? fallback() : error;
}

/** Every piece of FRAGMENT_LENGTH characters of the given values exactly as they are: no encoding, non-ASCII included. */
function rawPieces(values: Array<string | undefined>): LeakMatcher {
  const pieces = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (let i = 0; i + FRAGMENT_LENGTH <= value.length; i += 1) pieces.add(value.slice(i, i + FRAGMENT_LENGTH));
  }
  return {
    matches(text: string): boolean {
      for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
        if (pieces.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
      }
      return false;
    },
  };
}

/**
 * The ultimate fallback: name `Error`, an empty message and the stack `Error`. Its only text has five characters, so
 * no piece of FRAGMENT_LENGTH can match it: masking ends here.
 */
function ultimateError(): Error {
  const error = new Error('');
  delete (error as { cause?: unknown }).cause;
  for (const [key, value] of [['name', 'Error'], ['message', ''], ['stack', 'Error']] as const) {
    Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: false });
  }
  return error;
}

/**
 * The terminating check on a finished, sealed error, right before it leaves: against every registered value in its
 * raw form and, through `encoded`, its encoded forms. Masking can itself make a piece of a value (the "…" it writes
 * next to the text left over), so an error that holds one is replaced by the ultimate fallback, never masked again.
 */
function terminal(error: Error, raw: Array<string | undefined>, encoded: GatewayRedactor): Error {
  return leaksSecret(error, rawPieces(raw)) || leaksSecret(error, encoded) ? ultimateError() : error;
}

/** The error a call or a consent helper is refused with, in final form: masked against every secret, no frames. */
function refusal(text: string, ...secrets: string[]): EnableBankingGatewayError {
  return sealedError(new EnableBankingGatewayError(text), ...secrets);
}

function buildEnableBankingGateway(options: EnableBankingGatewayOptions) {
  if (!options || typeof options !== 'object') throw new Error('createEnableBankingGateway: options are required.');
  const applicationId = typeof options.applicationId === 'string' ? options.applicationId.trim() : '';
  if (!applicationId || !/^[A-Za-z0-9-]{1,128}$/.test(applicationId)) {
    throw new Error(
      'createEnableBankingGateway: applicationId is required (the gateway does not read ENABLEBANKING_* environment variables).',
    );
  }
  const redactor = new GatewayRedactor();
  let key: KeyObject;
  if (typeof options.privateKey === 'string') {
    if (!options.privateKey.trim()) throw new Error('createEnableBankingGateway: privateKey is required.');
    redactor.addKey(options.privateKey);
    try {
      key = createPrivateKey(options.privateKey);
    } catch {
      throw new Error('createEnableBankingGateway: privateKey is not a readable private key.');
    }
  } else if (options.privateKey && typeof options.privateKey === 'object' && options.privateKey.type === 'private') {
    key = options.privateKey;
    let pem = '';
    try {
      pem = String(key.export({ type: 'pkcs8', format: 'pem' }));
    } catch {
      pem = '';
    }
    if (!pemContent(pem)) throw new Error(KEY_REFUSED);
    redactor.addKey(pem);
  } else {
    throw new Error('createEnableBankingGateway: privateKey is required.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('createEnableBankingGateway: privateKey must be an RSA key (RS256).');
  // Key admission (src/key-admission.ts): key content, as given and as exported, that is short or shares a piece of
  // 6 characters with any text of our own is refused with a fixed text that never repeats it.
  const contents: string[] = [];
  if (typeof options.privateKey === 'string') contents.push(pemContent(options.privateKey));
  try {
    contents.push(pemContent(String(key.export({ type: 'pkcs8', format: 'pem' }))));
  } catch {
    // A key that cannot be exported cannot be echoed in this form either.
  }
  for (const content of contents) if (!admitsKey(content)) throw new Error(keyRefusedText(content));
  /** The key content, which every error is masked against. */
  const keyContent = contents[0] ?? '';
  // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
  if (leaksSecret(fixedOutputs(), redactor)) throw new Error(keyRefusedText(contents[0] ?? ''));

  const now = options.now ?? Date.now;
  // Where each issued page token continues; never leaves the instance.
  const pages = new PageTokens(now);
  /** The watch of every call under way, and the sessions ended here: an answer leaves only when its own watch stands. */
  const withdrawals = new Withdrawals(
    boundedInt(options.endedSessionsKept, DEFAULT_ENDED_SESSIONS_KEPT, 1, 1_000_000, 'endedSessionsKept'),
  );
  // Reads made with nobody present, per consent.
  const budget = new UnattendedBudget(
    boundedInt(options.unattendedFetchesPerDay, DEFAULT_UNATTENDED_FETCHES_PER_DAY, 0, 1_000, 'unattendedFetchesPerDay'),
    now,
  );
  const client = new GatewayClient({
    applicationId,
    key,
    origin: validateOrigin(options.apiBaseUrl ?? DEFAULT_API_BASE_URL),
    timeoutMs: boundedInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, 'timeoutMs'),
    maxResponseBytes: boundedInt(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1_024, 64 * 1024 * 1024, 'maxResponseBytes'),
    fetchImpl: options.fetchImpl ?? fetch,
  });

  /** Runs a consent helper; any failure becomes a redacted EnableBankingGatewayError without a cause. */
  async function helper<T>(
    inputs: Array<string | undefined>,
    work: (register: (secret: string, fromVendor?: boolean) => void) => Promise<T>,
  ): Promise<T> {
    const callRedactor = redactor.fork();
    // Every secret of the call: the inputs and anything registered while the call runs (a returned session id).
    // All of them are in the final seal and in the sink check of any error that leaves.
    const secrets: string[] = [];
    // A value Enable Banking returned that is not printable ASCII is never masked into a text: the call ends in the
    // ultimate fallback.
    let vendorUnprintable = false;
    // A value of the call: always in the final mask and the raw final check; added to redaction and the sink check
    // (which encode it) only when it is printable ASCII, so nothing is encoded that could make the encoding throw.
    const register = (secret: string, fromVendor = false) => {
      secrets.push(secret);
      if (fromVendor && !PRINTABLE_SECRET.test(secret)) {
        vendorUnprintable = true;
        throw new Error(RESULT_WITHHELD);
      }
      if (PRINTABLE_SECRET.test(secret)) {
        callRedactor.add(secret);
        callRedactor.watch(secret);
      }
    };
    let answer: unknown;
    try {
      // Inside the error boundary: each value is checked as printable ASCII before anything encodes it (a lone
      // surrogate would make the encoding throw), then registered.
      for (const input of inputs) {
        if (input === undefined) continue;
        register(input);
        if (!PRINTABLE_SECRET.test(input)) throw new Error(INPUT_REFUSED);
      }
      // The answer is the host's data (the session id included); only the instance's key is removed from it.
      // The outer pass is the final one, over the assembled answer.
      answer = redactor.redactDeep(redactor.redactDeep(await work(register)));
      if (vendorUnprintable) throw new Error(RESULT_WITHHELD);
    } catch (error) {
      if (vendorUnprintable) throw ultimateError();
      const details = httpDetails(error);
      const message = callRedactor.message(error);
      // A fresh error in final form (no cause, no frames, masked against the key and every secret of the call),
      // then the sink check on the finished object against the same secrets.
      const fallback = () => sealedError(new EnableBankingGatewayError(RESULT_WITHHELD), keyContent, ...secrets, ...inputs);
      const sealed = released(
        sealedError(
          new EnableBankingGatewayError(leaksSecret(message, callRedactor) ? RESULT_WITHHELD : message, details),
          keyContent,
          ...secrets,
          ...inputs,
        ),
        callRedactor,
        fallback,
      );
      // Then the terminating check against every registered value, raw and encoded.
      throw terminal(sealed, [keyContent, ...secrets, ...inputs], callRedactor);
    }
    // The sink check on the answer as it leaves: one that holds a piece of the key is withheld.
    if (leaksSecret(answer, redactor)) {
      const withheld = () => sealedError(new EnableBankingGatewayError(RESULT_WITHHELD), keyContent);
      throw terminal(released(withheld(), redactor, withheld), [keyContent], redactor);
    }
    return answer as T;
  }

  async function bankByName(country: string, psuType: 'business' | 'personal', name: string) {
    const banks = await client.listAspsps(country, psuType);
    return banks.find(candidate => candidate.name === name && candidate.country === country);
  }

  return {
    /** A fresh copy on each read, so one part of the host cannot change another's list. */
    get tools(): GatewayToolDefinition[] {
      return structuredClone(enableBankingGatewayTools) as GatewayToolDefinition[];
    },

    async callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      const callRedactor = redactor.fork();
      const sessionId = callCredentials(context)?.sessionId;
      if (sessionId !== undefined) {
        // Session admission, before anything else: a session id that is not printable ASCII of 16 characters or
        // more, or shares a piece with our texts or a fixed output, is refused. Not as a result, whose fixed fields
        // could hold a piece of it, but as an error whose text and name are masked.
        if (!sessionAdmitted(sessionId)) {
          // The sink check on the finished refusal, against the key and the session id.
          const check = redactor.fork();
          check.watch(sessionId);
          const fallback = () => refusal(RESULT_WITHHELD, sessionId, keyContent);
          throw terminal(released(refusal(SESSION_REFUSED, sessionId, keyContent), check, fallback), [sessionId, keyContent], check);
        }
        callRedactor.add(sessionId);
        callRedactor.watch(sessionId);
      }
      // The details of the person present go to the bank and nowhere else: whatever a bank answers, they are removed
      // from the result and from every error text of this call. The address and the location always (their shape is
      // checked), also in another spelling that says the same; the free-text values like any other value this
      // gateway removes, from MIN_SECRET_LENGTH characters, so that a browser name of a few letters cannot blank the
      // same word in a bank line. What this does and does not promise is in the README ("Who is present").
      let presence: Presence | { kind: 'refused'; reason: string };
      try {
        presence = callPresence(context);
      } catch {
        presence = { kind: 'refused', reason: PSU_REFUSED };
      }
      if (presence.kind === 'present') {
        for (const [header, value] of Object.entries(presence.headers)) {
          if (header === PSU_HEADER_NAMES.ipAddress) callRedactor.addAddress(value);
          else if (header === PSU_HEADER_NAMES.geoLocation) callRedactor.addLocation(value);
          else callRedactor.add(value);
        }
      }
      let result: GatewayToolResult;
      // The call's watch, registered on its session before anything is awaited: every fact learned about the session
      // from now on, from any request, is put on it. Narrowed to the accounts the call names once it is read.
      const accountIds = callCredentials(context)?.accountIds;
      const watch = sessionId === undefined || !accountIds ? undefined : withdrawals.begin(sessionId, accountIds.keys());
      try {
        try {
          result = await runCall(toolName, input ?? {}, context, presence, watch);
        } catch (error) {
          // The text is ours; the code says what went wrong without it. Anything unnamed is a failure at Enable Banking.
          result = errorResult(callRedactor.message(error), failureMetadata(error), problemOf(error) ?? 'upstream_error');
        }
        // After the call's last await, and nothing awaited from here to the return: an answer read under a consent
        // that was ended or ran out, or from an account that left it, while the call ran (at any await) does not leave.
        // Only the call's own watch and the clock are read.
        if (watch && result.isError !== true && !withdrawals.stands(watch, now())) {
          result = errorResult(WITHDRAWN_MEANWHILE, undefined, 'consent_not_active');
        }
      } finally {
        if (watch) withdrawals.done(watch);
      }
      // Every result, refusals and errors included, through the call's redactor, and then the sink check as the very
      // last step: a result that holds a piece of the key or the session id anywhere is withheld whole.
      const final = redactResult(result, callRedactor);
      return leaksSecret(final, callRedactor) ? withheldResult() : final;
    },

    /**
     * Banks (ASPSPs) offering account information. Without a country: every country the application covers.
     * Without a PSU type: banks for business and for personal customers.
     */
    listBanks(input: { country?: string; psuType?: 'business' | 'personal' } = {}): Promise<EnableBankingBank[]> {
      return helper([], async () => {
        const country = input.country === undefined ? undefined : checkCountry(input.country);
        const psuType = input.psuType === undefined ? undefined : checkPsuType(input.psuType);
        const banks = await client.listAspsps(country, psuType);
        return banks.filter(bank => typeof bank?.name === 'string' && typeof bank.country === 'string').map(bankView);
      });
    },

    /**
     * Starts a consent at a bank and returns the bank's page. `validUntil` is
     * checked against the bank's maximum consent length. The host must keep
     * `state`, check it when the person returns, and use it once.
     */
    startAuthorization(input: StartAuthorizationInput): Promise<StartAuthorizationResult> {
      return helper([input?.state], async () => {
        if (!input || typeof input !== 'object') throw new Error('startAuthorization: input is required.');
        if (input.country === undefined) throw new Error('startAuthorization: country is required (the two-letter country code of the bank).');
        const country = checkCountry(input.country);
        const psuType = checkPsuType(input.psuType);
        const bankName = typeof input.bank === 'string' ? input.bank.trim() : '';
        if (!bankName || bankName.length > 200) throw new Error('startAuthorization: bank is required.');
        const redirectUrl = checkRedirectUrl(input.redirectUrl);
        if (typeof input.state !== 'string' || !STATE_PATTERN.test(input.state)) {
          throw new Error('startAuthorization: state must be 16-512 characters of A-Z, a-z, 0-9, ".", "_", "~" or "-".');
        }
        if (input.language !== undefined && (typeof input.language !== 'string' || !LANGUAGE_PATTERN.test(input.language))) {
          throw new Error('startAuthorization: language must be two lower-case letters.');
        }
        for (const flag of ['balances', 'transactions', 'extendedHistory'] as const) {
          if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw new Error(`startAuthorization: ${flag} must be true or false.`);
        }
        const accounts = checkAccountSelection(input.accounts);

        const bank = await bankByName(country, psuType, bankName);
        if (!bank) throw new Error(`startAuthorization: no bank named that offers account information to ${psuType} customers in ${country}.`);
        let authMethod: string | undefined;
        if (input.authMethod !== undefined) {
          const offered = (Array.isArray(bank.auth_methods) ? bank.auth_methods : []).filter(
            method => typeof method?.name === 'string' && (method.psu_type === undefined || method.psu_type === null || method.psu_type === psuType),
          );
          authMethod = offered.find(method => method.name === input.authMethod)?.name ?? undefined;
          if (!authMethod || !TOKEN_PATTERN.test(authMethod)) {
            throw new Error(`startAuthorization: the bank offers no such authMethod to ${psuType} customers (see listBanks).`);
          }
        }
        const maximumSeconds =
          typeof bank.maximum_consent_validity === 'number' && bank.maximum_consent_validity > 0
            ? bank.maximum_consent_validity
            : DEFAULT_MAXIMUM_CONSENT_SECONDS;
        const latest = now() + maximumSeconds * 1000;
        let validUntil: number;
        if (input.validUntil === undefined) {
          validUntil = latest - 5 * 60_000;
        } else {
          validUntil = input.validUntil instanceof Date ? input.validUntil.getTime() : Date.parse(String(input.validUntil));
          if (Number.isNaN(validUntil)) throw new Error('startAuthorization: validUntil is not a date and time.');
          if (validUntil <= now() + 60 * 60_000) throw new Error('startAuthorization: validUntil must be at least an hour from now.');
          if (validUntil > latest) {
            throw new Error(`startAuthorization: validUntil is beyond the bank's maximum of ${Math.floor(maximumSeconds / 86_400)} days.`);
          }
        }
        const validUntilIso = new Date(validUntil).toISOString();

        const answer = await client.startAuthorization({
          access: {
            valid_until: validUntilIso,
            ...(accounts ? { accounts } : {}),
            ...(input.balances === undefined ? {} : { balances: input.balances }),
            ...(input.transactions === undefined ? {} : { transactions: input.transactions }),
            ...(input.extendedHistory === undefined ? {} : { transactions_extended_history: input.extendedHistory }),
          },
          aspsp: { name: bank.name, country: bank.country },
          state: input.state,
          redirect_url: redirectUrl,
          psu_type: psuType,
          ...(authMethod ? { auth_method: authMethod } : {}),
          ...(input.language ? { language: input.language } : {}),
        });
        const url = typeof answer?.url === 'string' ? answer.url : '';
        let parsed: URL | undefined;
        try {
          parsed = new URL(url);
        } catch {
          parsed = undefined;
        }
        if (!parsed || parsed.protocol !== 'https:') throw new Error('startAuthorization: Enable Banking did not return an https address for the bank.');
        const authorizationId = answer?.authorization_id;
        return {
          url: parsed.toString(),
          validUntil: validUntilIso,
          maximumConsentDays: Math.floor(maximumSeconds / 86_400),
          authorizationId: typeof authorizationId === 'string' && TOKEN_PATTERN.test(authorizationId) ? authorizationId : null,
        };
      });
    },

    /**
     * Exchanges the `code` from the redirect for a session. The host checks
     * the returned `state` itself before calling this. The result's sessionId
     * and account ids are what the host stores as the company's credentials.
     * A consent that covers no readable account comes back as a result with
     * `outcome: 'no_accounts'`, not as an error.
     */
    completeSession(input: { code: string }): Promise<CompleteSessionResult> {
      const code = input && typeof input === 'object' ? input.code : undefined;
      return helper([typeof code === 'string' ? code : undefined], async register => {
        if (typeof code !== 'string' || !CODE_PATTERN.test(code)) throw new Error('completeSession: code is missing or malformed.');
        // The session id Enable Banking returns is a secret of this call from the raw answer on, before the
        // normalisation (which can drop it) and before its format is checked: in the final seal and sink check.
        const session = await client.createSession(code, raw => {
          const returned = raw && typeof raw === 'object' ? (raw as { session_id?: unknown }).session_id : undefined;
          if (typeof returned === 'string') register(returned, true);
        });
        const sessionId = session?.session_id;
        // The returned session id is a secret of this call from here on, before its format is checked: in the final
        // seal and, when printable, in the sink check.
        if (typeof sessionId === 'string') register(sessionId, true);
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
          throw new Error('completeSession: Enable Banking did not return a usable session.');
        }
        if (!sessionAdmitted(sessionId)) {
          // The sink check on the finished refusal, against the key and the session id.
          const check = redactor.fork();
          check.watch(sessionId);
          const fallback = () => refusal(RESULT_WITHHELD, sessionId, keyContent);
          throw released(refusal(SESSION_REFUSED, sessionId, keyContent), check, fallback);
        }
        const rawAccounts = Array.isArray(session?.accounts) ? session.accounts : [];
        // Its validity date and accounts, for the calls that will run under it.
        withdrawals.status(
          sessionId,
          { status: 'AUTHORIZED', access: session?.access, accounts: rawAccounts.map(account => account?.uid).filter((uid): uid is string => typeof uid === 'string') },
          now(),
          new Set(rawAccounts.map(account => account?.uid).filter((uid): uid is string => typeof uid === 'string')),
        );
        const accounts: ConsentAccount[] = [];
        let accountsWithoutId = 0;
        for (const account of rawAccounts) {
          if (typeof account?.uid !== 'string' || !ID_PATTERN.test(account.uid)) {
            accountsWithoutId += 1;
            continue;
          }
          accounts.push(consentAccount(account as AccountResource & { uid: string }));
        }
        return {
          sessionId,
          outcome: accounts.length > 0 ? ('connected' as const) : ('no_accounts' as const),
          validUntil: instant(session?.access?.valid_until),
          bank: sessionBank(session),
          psuType: typeof session?.psu_type === 'string' ? session.psu_type : null,
          accounts,
          accountsWithoutId,
          access: sessionAccess(session),
        };
      });
    },

    /** The state of a session at Enable Banking (for renewal reminders). Not a read at the bank. */
    sessionStatus(input: { sessionId: string }): Promise<SessionStatusResult> {
      const sessionId = input && typeof input === 'object' ? input.sessionId : undefined;
      return helper([typeof sessionId === 'string' ? sessionId : undefined], async () => {
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('sessionStatus: sessionId is missing or malformed.');
        // What Enable Banking says here counts for every call under way under the session, as on a call's own check.
        const session = await client.getSession(sessionId).catch((error: unknown) => {
          withdrawals.failed(sessionId, problemOf(error));
          throw error;
        });
        withdrawals.status(sessionId, session, now(), sessionAccounts(session));
        return {
          status: typeof session?.status === 'string' && SESSION_STATUSES.has(session.status) ? session.status : null,
          validUntil: instant(session?.access?.valid_until),
          accountIds: [...sessionAccounts(session)],
          accounts: sessionAccountHashes(session),
          bank: sessionBank(session),
          psuType: session?.psu_type === 'business' || session?.psu_type === 'personal' ? session.psu_type : null,
          createdAt: instant(session?.created),
          authorizedAt: instant(session?.authorized),
          closedAt: instant(session?.closed),
          access: sessionAccess(session),
        };
      });
    },

    /**
     * Closes a session at Enable Banking, which ends the consent at the bank: for when a company removes the
     * connection, renews it (end the old session once the new one is stored) or is closed. A session that Enable
     * Banking says is already closed, expired, revoked or unknown counts as ended (`alreadyEnded: true`); any
     * other failure is thrown, and the session may then still be open.
     */
    endSession(input: { sessionId: string }): Promise<EndSessionResult> {
      const sessionId = input && typeof input === 'object' ? input.sessionId : undefined;
      return helper([typeof sessionId === 'string' ? sessionId : undefined], async () => {
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('endSession: sessionId is missing or malformed.');
        // Ended from the moment it is asked for: no answer read under it is returned by this instance any more, also
        // one of a call already under way or one that starts while the session is being ended.
        withdrawals.ending(sessionId);
        try {
          await client.deleteSession(sessionId);
        } catch (error) {
          const problem = problemOf(error);
          if (problem === 'consent_expired' || problem === 'consent_revoked' || problem === 'consent_not_active') return { alreadyEnded: true };
          throw error;
        } finally {
          withdrawals.endingDone(sessionId);
        }
        return { alreadyEnded: false };
      });
    },

    /**
     * The application as Enable Banking sees it: environment, whether it is active, countries and services. For a
     * host's own health check. An application refused here (errors with `problem: 'application_refused'`) is refused
     * for every company, whatever their consents.
     */
    application(): Promise<EnableBankingApplicationStatus> {
      return helper([], async () => {
        const application = await client.getApplication();
        const strings = (value: unknown, pattern: RegExp): string[] =>
          Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && pattern.test(entry)) : [];
        return {
          environment: application?.environment === 'PRODUCTION' || application?.environment === 'SANDBOX' ? application.environment : null,
          active: typeof application?.active === 'boolean' ? application.active : null,
          countries: strings(application?.countries, COUNTRY_PATTERN),
          services: strings(application?.services, /^[A-Z]{2,8}$/),
          redirectUrls: strings(application?.redirect_urls, /^https?:\/\/[\x21-\x7E]{1,2000}$/),
        };
      });
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
    presence: Presence | { kind: 'refused'; reason: string },
    watch: CallWatch | undefined,
  ): Promise<GatewayToolResult> {
    const resolution = parseCall(toolName, input, now());
    if (!resolution.ok) return errorResult(resolution.reason, undefined, resolution.code);
    const { target, call } = resolution;

    const credentials = callCredentials(context);
    if (!credentials) return errorResult(NO_CREDENTIALS, undefined, 'no_consent');
    const named = [...(target.account === undefined ? [] : [target.account]), ...(target.accounts ?? [])];
    if (named.some(account => !credentials.accountIds.has(account))) return errorResult(NOT_ALLOWED, undefined, 'account_not_connected');
    // The accounts the answer may come from: those named, else every account of the call. Before any await.
    if (watch && named.length > 0) watch.accounts = new Set(named);
    const learn = (problem: ProblemCode | undefined, account?: string) => withdrawals.failed(credentials.sessionId, problem, account, watch);

    // Who is behind the call, before anything is sent: a malformed answer is refused, never read as "nobody".
    if (presence.kind === 'refused') return errorResult(presence.reason, undefined, 'presence_incomplete');

    // The bank session must still be authorised and still contain the account. Asked of Enable Banking on every
    // call; it is not a read at the bank. No answer is kept between calls: every answer is read under the consent
    // and the account list of its own call.
    const session = await client.getSession(credentials.sessionId).catch((error: unknown) => {
      learn(problemOf(error));
      throw error;
    });
    // What the status says counts for every call under way: an ended consent, the accounts it still lists, and when
    // it runs out (checked again when the answer of this call is returned).
    withdrawals.status(credentials.sessionId, session, now(), sessionAccounts(session));
    const consent = consentState(session, now());
    if (!consent.ok) return errorResult(consent.reason, undefined, consent.code);
    // Accounts of the call the session no longer lists are not read by it: what this status says of them is not
    // held against its own answer.
    for (const account of credentials.accountIds.keys()) if (!consent.accounts.has(account)) watch?.own.add(account);
    if (named.some(account => !consent.accounts.has(account))) return errorResult(NOT_IN_CONSENT, undefined, 'account_not_in_consent');

    let start: PageState | undefined;
    if (call.tool === 'list_transactions') {
      const bound = {
        session: credentials.sessionId,
        a: call.account,
        f: call.period.from ?? '',
        t: call.period.to ?? '',
        s: call.period.status,
        g: call.period.strategy,
      };
      if (call.pageToken) {
        start = pages.find(call.pageToken);
        if (!start) return errorResult(PAGE_TOKEN_UNKNOWN, undefined, 'page_token_invalid');
        if (
          start.session !== bound.session ||
          start.a !== bound.a ||
          start.f !== bound.f ||
          start.t !== bound.t ||
          start.s !== bound.s ||
          start.g !== bound.g
        ) {
          return errorResult(PAGE_TOKEN_MISMATCH, undefined, 'page_token_invalid');
        }
      }
    }
    const period = call.tool === 'list_transactions' ? call.period : undefined;
    const issuePageToken = (next: { k: string; o: number }) =>
      pages.issue({
        ...next,
        session: credentials.sessionId,
        a: call.tool === 'list_transactions' ? call.account : '',
        f: period?.from ?? '',
        t: period?.to ?? '',
        s: period?.status ?? '',
        g: period?.strategy ?? '',
      });

    // Nobody present: the read is taken from the day's budget for this consent, or refused before anything is sent.
    // A continued page takes nothing from the budget (it belongs to the read that started the listing), but it is a
    // request to the bank all the same: the pause after the bank's rate limit holds for it like for any other.
    const reads = bankReads(call, credentials, consent);
    const continued = call.tool === 'list_transactions' && call.pageToken !== undefined;
    if (presence.kind === 'unattended' && (reads > 0 || continued)) {
      const decision = budget.take(credentials.sessionId, reads);
      if (!decision.ok) return errorResult(budgetRefusal(decision), undefined, 'unattended_limit');
    }

    // The bank says its limit is reached: no further background read for this consent until the pause is over.
    // Also when the failure ends up inside an answer (a search that read some accounts and not others).
    const onProblem = (problem: ProblemCode | undefined) => {
      if (problem === 'rate_limited' && presence.kind !== 'present') budget.block(credentials.sessionId);
    };
    try {
      return await runTool(
        { client: learning(client, learn), now, issuePageToken, onProblem, ...(presence.kind === 'present' ? { presence: presence.headers } : {}) },
        call,
        credentials,
        consent,
        start ? { k: start.k, o: start.o } : undefined,
      );
    } catch (error) {
      onProblem(problemOf(error));
      throw error;
    }
  }
}

/** The reads at the bank, by account: what each failure says about the consent or the account is learned first. */
const ACCOUNT_READS: ReadonlySet<string> = new Set(['getAccountDetails', 'getBalances', 'getTransaction', 'getTransactionsPage']);

/** The client of one call: every failed read of an account is told to `learn`, with the account, before it is thrown. */
function learning(client: GatewayClient, learn: (problem: ProblemCode | undefined, account?: string) => void): GatewayClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !ACCOUNT_READS.has(property) || typeof value !== 'function') return value;
      return async (account: string, ...rest: unknown[]) => {
        try {
          return await (value as (...args: unknown[]) => Promise<unknown>).call(target, account, ...rest);
        } catch (error) {
          learn(problemOf(error), account);
          throw error;
        }
      };
    },
  });
}

/** One gateway instance, as returned by createEnableBankingGateway. */
export type EnableBankingGateway = ReturnType<typeof createEnableBankingGateway>;

// ------------------------------------------------------------------ helpers

function checkCountry(value: unknown): string {
  const country = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!COUNTRY_PATTERN.test(country)) throw new Error('country must be a two-letter country code.');
  return country;
}

function checkPsuType(value: unknown): 'business' | 'personal' {
  if (value === undefined) return 'business';
  if (value === 'business' || value === 'personal') return value;
  throw new Error('psuType must be business or personal.');
}

function checkRedirectUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('startAuthorization: redirectUrl must be an absolute https address.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new Error('startAuthorization: redirectUrl must be an absolute https address without credentials or fragment.');
  }
  return url.toString();
}

/** The accounts to ask a bank for, as the API takes them, or undefined when none were named. */
function checkAccountSelection(value: unknown): AccountIdentification[] | undefined {
  if (value === undefined) return undefined;
  const refused = () =>
    new Error(`startAuthorization: accounts must be 1 to ${MAX_SELECTED_ACCOUNTS} entries of { iban } or { scheme, identification }.`);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SELECTED_ACCOUNTS) throw refused();
  return value.map((entry: unknown): AccountIdentification => {
    if (!entry || typeof entry !== 'object') throw refused();
    const { iban, scheme, identification } = entry as { iban?: unknown; scheme?: unknown; identification?: unknown };
    if (typeof iban === 'string' && scheme === undefined && identification === undefined) {
      const normalised = normalizeIban(iban);
      if (!isValidIban(normalised)) throw new Error('startAuthorization: an iban in accounts is not a valid IBAN.');
      return { iban: normalised };
    }
    if (iban === undefined && typeof scheme === 'string' && typeof identification === 'string' && /^[A-Z]{2,8}$/.test(scheme) && IDENTIFICATION_PATTERN.test(identification)) {
      return { other: { scheme_name: scheme, identification } };
    }
    throw refused();
  });
}

function plain(value: unknown, max = 200): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function authMethodView(method: AuthMethod): EnableBankingAuthMethod | undefined {
  const name = plain(method?.name);
  if (!name) return undefined;
  const credentials = Array.isArray(method.credentials) ? method.credentials : [];
  return {
    name,
    title: plain(method.title),
    psuType: method.psu_type === 'business' || method.psu_type === 'personal' ? method.psu_type : null,
    approach: method.approach === 'REDIRECT' || method.approach === 'DECOUPLED' || method.approach === 'EMBEDDED' ? method.approach : null,
    hidden: method.hidden_method === true,
    // What is asked for, never a value: a host's page can tell the person what the bank will want.
    credentials: credentials.flatMap(credential => {
      const credentialName = plain(credential?.name);
      return credentialName ? [{ name: credentialName, title: plain(credential.title), required: credential.required === true }] : [];
    }),
  };
}

/** A bank as listBanks returns it. The sandbox test users and the payment types of the raw answer are not passed on. */
function bankView(bank: Aspsp): EnableBankingBank {
  const seconds = typeof bank.maximum_consent_validity === 'number' && bank.maximum_consent_validity > 0 ? bank.maximum_consent_validity : null;
  const logo = plain(bank.logo, 2000);
  const known = new Set(Object.values(PSU_HEADER_NAMES).map(name => name.toLowerCase()));
  return {
    name: bank.name,
    country: bank.country,
    bic: typeof bank.bic === 'string' ? bank.bic : null,
    psuTypes: Array.isArray(bank.psu_types) ? bank.psu_types.filter(value => typeof value === 'string') : [],
    maximumConsentDays: seconds === null ? null : Math.floor(seconds / 86_400),
    maximumConsentSeconds: seconds,
    beta: bank.beta === true,
    sandbox: bank.sandbox !== undefined && bank.sandbox !== null && bank.sandbox !== false,
    group: plain(bank.group?.name),
    logoUrl: logo && /^https:\/\//.test(logo) ? logo : null,
    authMethods: (Array.isArray(bank.auth_methods) ? bank.auth_methods : []).flatMap(method => authMethodView(method) ?? []),
    // Only header names the API documents: anything else in the list is not passed on.
    requiredPsuHeaders: (Array.isArray(bank.required_psu_headers) ? bank.required_psu_headers : []).filter(
      (header): header is string => typeof header === 'string' && known.has(header.toLowerCase()),
    ),
  };
}

/** Status and code of our own HTTP error only; the code is one of Enable Banking's documented codes. */
function httpDetails(error: unknown): { status?: number; code?: string; problem?: ProblemCode } {
  const problem = problemOf(error);
  if (!(error instanceof EnableBankingHttpError)) return problem ? { problem } : {};
  return {
    status: error.status,
    ...(error.code !== undefined && ERROR_CODES.has(error.code) ? { code: error.code } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** The content of a PEM key, without armour and whitespace: what the redactor holds pieces of. */
function pemContent(pem: string): string {
  return pem.replace(/-----(BEGIN|END) [A-Z ]*-----/g, '').replace(/\s+/g, '');
}

/**
 * A result as returned to the host: its structured data normalised to JSON
 * and then redacted as values (object keys included), its text redacted.
 * Account ids stay: only the call's values and pieces of the key are removed.
 */
function redactResult(result: GatewayToolResult, redactor: GatewayRedactor): GatewayToolResult {
  // The failure metadata in form or dropped: a status of 100-599 and a request id that is still one after redaction.
  const failure = failureInForm(result.isError, redactor.redactDeep(result.failure));
  // Our own fixed code, or nothing: never a text.
  const errorCode = result.isError && isProblemCode(result.errorCode) ? result.errorCode : undefined;
  const retryAfter = result.retryAfterSeconds;
  return {
    ...(result.isError ? { isError: true } : {}),
    ...(failure ? { failure } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(result.isError && typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    content: result.content.map(part => ({ type: 'text' as const, text: redactor.redactValues(redactor.redactValues(part.text)) })),
    // Redacted first, as data and depth-limited, and only then copied as JSON. The outer pass is the final one, over
    // the assembled data with its depth placeholders.
    ...(result.structuredContent === undefined
      ? {}
      : {
          structuredContent: JSON.parse(
            JSON.stringify(redactor.redactDeep(redactor.redactDeep(result.structuredContent))),
          ) as GatewayJsonValue,
        }),
  };
}
