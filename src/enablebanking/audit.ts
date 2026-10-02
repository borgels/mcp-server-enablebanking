import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

export interface AuditEvent {
  company: string;
  actingAs: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'denied';
  /** Which account was read (registry id), so a read can be traced without logging data. */
  account?: string;
  target?: unknown;
  reason?: string;
  error?: string;
}

/**
 * One JSON line per tool call: who, which company, which tool, which account.
 * Arguments are hashed; balances, transactions and bank addresses are never
 * logged.
 */
export async function writeAuditEvent(path: string | undefined, event: AuditEvent): Promise<void> {
  if (!path) return;
  const { target, ...rest } = event;
  const record = {
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    ...rest,
    targetHash: target === undefined ? undefined : createHash('sha256').update(JSON.stringify(target)).digest('hex'),
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}
