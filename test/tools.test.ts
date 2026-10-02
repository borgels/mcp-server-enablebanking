import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnableBankingConfig } from '../src/enablebanking/config.js';
import { createServer } from '../src/server.js';
import { makeBank } from './helpers.js';

async function connect(config: Partial<EnableBankingConfig>, actingAs = 'anna@example.com') {
  const { bank } = makeBank();
  const full = { consentEnabled: false, consentAdmins: [], ...config } as EnableBankingConfig;
  const server = createServer({ bank, config: full, actingAs });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

describe('tool surface', () => {
  it('offers only read tools unless consent management is enabled', async () => {
    const client = await connect({});
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual([
      'enablebanking_get_account_details',
      'enablebanking_get_balances',
      'enablebanking_list_accounts',
      'enablebanking_list_transactions',
      'enablebanking_search_capabilities',
    ]);
    expect(names.some(name => /pay|transfer/.test(name))).toBe(false);
  });

  it('adds consent tools when enabled, and enforces the admin allowlist with an audit line', async () => {
    const auditLog = join(mkdtempSync(join(tmpdir(), 'eb-audit-')), 'audit.jsonl');
    const client = await connect({ consentEnabled: true, consentAdmins: ['anna@example.com'], auditLog }, 'carl@example.org');
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('enablebanking_start_consent');
    const result = await client.callTool({ name: 'enablebanking_start_consent', arguments: { bank: 'Danske Bank' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('may not manage bank consents');
    const lines = readFileSync(auditLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ company: 'aaa', actingAs: 'carl@example.org', tool: 'enablebanking_start_consent', action: 'denied' });
  });

  it('lists the company and its accounts, and reports errors as tool errors', async () => {
    const client = await connect({});
    const listed = await client.callTool({ name: 'enablebanking_list_accounts', arguments: {} });
    const body = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text);
    expect(body.company).toEqual({ code: 'aaa', name: 'Alfa Drift ApS', cvr: '12345678' });
    expect(body.accounts.map((a: { id: string; status: string }) => `${a.id}:${a.status}`)).toEqual(['drift:no_consent', 'skat:no_consent']);
    const balances = await client.callTool({ name: 'enablebanking_get_balances', arguments: { account: 'drift' } });
    expect(balances.isError).toBe(true);
  });
});
