// An answer with bank data never outlives a withdrawal: the standalone server checks the consent and every account an
// answer comes from after the tool's last await (the audit line), synchronously before the answer leaves. Each data
// tool is held at its final audit line while the consent is revoked or an account leaves it. Made-up data only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/enablebanking/audit.js';
import type { Bank } from '../src/enablebanking/bank.js';
import { registerTools } from '../src/tools/enablebanking.js';
import { IBAN, fakeApi, linkConsent, makeBank } from './helpers.js';

const BOTH = [
  { uid: 'uid-aaa-drift', account_id: { iban: IBAN.aaaDrift }, name: 'Drift', currency: 'DKK' },
  { uid: 'uid-aaa-skat', account_id: { iban: IBAN.aaaSkat }, name: 'Skat', currency: 'EUR' },
];
const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

/** Every tool whose answer holds bank data (or the consents' state), with arguments that read the drift account. */
const DATA_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['enablebanking_get_balances', { account: 'drift' }],
  ['enablebanking_get_account_details', { account: 'drift' }],
  ['enablebanking_list_transactions', { account: 'drift', ...PERIOD }],
  ['enablebanking_get_transaction_details', { account: 'drift', transaction: 'id-1' }],
  ['enablebanking_summarize_transactions', { account: 'drift', ...PERIOD }],
  ['enablebanking_search_transactions', { search: 'husleje', ...PERIOD }],
  ['enablebanking_get_consent_status', {}],
];

/** An audit writer that can hold a call at its final line ("finish") until released. */
function gate() {
  const events: AuditEvent[] = [];
  let hold = false;
  let reached: (() => void) | undefined;
  let release: (() => void) | undefined;
  const writer = async (event: AuditEvent) => {
    events.push(event);
    if (hold && event.action === 'finish') {
      await new Promise<void>(resolve => {
        release = resolve;
        reached?.();
      });
    }
  };
  return {
    events,
    writer,
    /** Holds the next call at its final audit line; resolves once it is there. */
    holdNext(): Promise<void> {
      hold = true;
      return new Promise<void>(resolve => {
        reached = resolve;
      });
    },
    open(): void {
      hold = false;
      release?.();
    },
  };
}

async function setup(accounts = BOTH) {
  const api = fakeApi({
    'GET /accounts/[^/]+/transactions/[^/]+': () => ({
      transaction_id: 'id-1',
      transaction_amount: { amount: '5.00', currency: 'DKK' },
      credit_debit_indicator: 'DBIT',
      creditor: { name: 'Leverandør ApS' },
    }),
  });
  api.setSessionAccounts(accounts);
  const { bank } = makeBank({ api });
  await bank.completeConsent({ user: 'anna@example.com', redirectUrl: (await linkConsent(bank, api)).redirect });
  const audit = gate();
  const server = new McpServer({ name: 'test', version: '1' });
  registerTools(server, bank, { actingAs: 'anna@example.com', consentEnabled: true, consentAdmins: [], audit: audit.writer });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return { api, bank, audit, client };
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
const consentKey = (bank: Bank) => bank.listAccounts().consents[0]!.consent;

describe('an answer with bank data, checked after the last await', () => {
  it.each(DATA_TOOLS)('%s answers as usual when nothing changes while its audit line is written', async (tool, args) => {
    const { audit, client } = await setup();
    const held = audit.holdNext();
    const call = client.callTool({ name: tool, arguments: args });
    await held;
    audit.open();
    const result = await call;
    expect(result.isError, text(result)).toBeFalsy();
  });

  it.each(DATA_TOOLS)('%s returns nothing read under a consent revoked while its final audit line is written', async (tool, args) => {
    const { audit, bank, client } = await setup();
    const held = audit.holdNext();
    const call = client.callTool({ name: tool, arguments: args });
    await held;
    // The call has read the bank, passed every check of its own and waits on the audit log: the consent is revoked.
    await bank.revokeConsent(consentKey(bank));
    audit.open();
    const result = await call;
    const body = text(result);
    expect(body).not.toContain('1234.50');
    expect(body).not.toMatch(/Leverand|Husleje|-250\.00/i);
    if (tool === 'enablebanking_search_transactions') {
      // A search shows what it could not return, account by account, with why.
      const found = JSON.parse(body);
      expect(found.transactions).toEqual([]);
      expect(found.count).toBe(0);
      expect(found.accounts.every((entry: { read: boolean }) => !entry.read)).toBe(true);
    } else if (tool === 'enablebanking_get_consent_status') {
      const status = JSON.parse(body);
      expect(status.consents[0]).toMatchObject({ status: null, problem: 'consent_not_active' });
    } else {
      expect(result.isError).toBe(true);
      expect(body).toMatch(/errorCode: (no_consent|consent_not_active)/);
    }
    // The audit says how the call ended: finished at the bank, then withheld.
    if (result.isError) expect(audit.events.at(-1)).toMatchObject({ tool, action: 'error' });
  });

  it.each(DATA_TOOLS.filter(([tool]) => tool !== 'enablebanking_get_consent_status'))(
    '%s returns nothing from an account that left the consent while its final audit line is written',
    async (tool, args) => {
      const { api, audit, bank, client } = await setup();
      const held = audit.holdNext();
      const call = client.callTool({ name: tool, arguments: args });
      await held;
      // Enable Banking now lists only the skat account: a refresh binds the consent without drift.
      api.setSessionAccounts([BOTH[1]!]);
      await bank.refreshConsent(consentKey(bank));
      audit.open();
      const result = await call;
      const body = text(result);
      if (tool === 'enablebanking_search_transactions') {
        // The skat account is still in the consent; nothing of drift is in the answer.
        const found = JSON.parse(body);
        expect(found.transactions.filter((line: { account: string }) => line.account === 'drift')).toEqual([]);
        expect(found.accounts.find((entry: { account: string }) => entry.account === 'drift')).toMatchObject({ read: false });
      } else {
        expect(body).not.toContain('1234.50');
        expect(body).not.toMatch(/Leverand|Husleje|-250\.00/i);
        expect(result.isError).toBe(true);
      }
    },
  );

  it('keeps what the other accounts of a search gave when one account leaves during the final audit line', async () => {
    const { api, audit, bank, client } = await setup();
    const held = audit.holdNext();
    const call = client.callTool({ name: 'enablebanking_search_transactions', arguments: { search: 'faktura', ...PERIOD } });
    await held;
    api.setSessionAccounts([BOTH[1]!]);
    await bank.refreshConsent(consentKey(bank));
    audit.open();
    const found = JSON.parse(text(await call));
    expect(found.accounts).toMatchObject([
      { account: 'drift', read: false },
      { account: 'skat', read: true },
    ]);
    expect(found.transactions.every((line: { account: string }) => line.account === 'skat')).toBe(true);
    expect(found.transactions.length).toBeGreaterThan(0);
  });

  it('refuses an answer the bank did not make (fail closed): only the tools without bank data skip the check', () => {
    const { bank } = makeBank({ api: fakeApi() });
    expect(() => bank.release({ balances: [] })).toThrow(/withheld/);
  });
});
