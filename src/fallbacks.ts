/**
 * The fixed outputs of the sink check (src/key-admission.ts): what leaves a
 * gateway instead of an output that holds a piece of the key or of the
 * call's session id. A small closed set; a key or a session id that shares a
 * piece with any of them is refused (the key when the gateway is created,
 * the session id when the call starts), so a fallback never holds a piece of
 * either.
 */

/** The text of a result, or of a consent helper's error, that was withheld. */
export const RESULT_WITHHELD = 'Withheld: the answer held text that matches the key of this instance or the session.';

/** The text of the error a call is refused with when its session id cannot be used safely. */
export const SESSION_REFUSED = 'Refused: this bank connection cannot be used safely. It must be connected again.';

/** The result a host gets instead of one that held a piece of the key or the session id. */
export function withheldResult(): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return { isError: true, content: [{ type: 'text', text: RESULT_WITHHELD }] };
}

/** Names a host may log with an error: the error classes a gateway throws. */
const ERROR_NAMES = ['EnableBankingGatewayError', 'Error'];

/** Every fixed output, as a host sees it. */
export function fixedOutputs(): unknown[] {
  return [withheldResult(), RESULT_WITHHELD, SESSION_REFUSED, ...ERROR_NAMES];
}
