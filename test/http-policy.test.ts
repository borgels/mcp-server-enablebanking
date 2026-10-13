import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/enablebanking/config.js';
import { httpBankConfig } from '../src/transports/http-policy.js';

function cfg(env: Record<string, string>) {
  return loadConfig({ ENABLEBANKING_COMPANY: 'aaa', ...env });
}

describe('HTTP bank config policy', () => {
  it('refuses to start with a trusted forwarded user but no MCP_HTTP_TOKEN', () => {
    const env = { ENABLEBANKING_TRUST_FORWARDED_USER: 'true' };
    expect(() => httpBankConfig(cfg(env), {}, env)).toThrow(/MCP_HTTP_TOKEN/);
  });

  it('keeps consent tools when the gateway identity is trusted', () => {
    const env = { ENABLEBANKING_TRUST_FORWARDED_USER: 'true', ENABLEBANKING_ENABLE_CONSENT: 'true' };
    const { config, warnings } = httpBankConfig(cfg(env), { httpToken: 't' }, env);
    expect(config.consentEnabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('disables consent tools over HTTP without a trusted forwarded user', () => {
    const env = { ENABLEBANKING_ENABLE_CONSENT: 'true' };
    const { config, warnings } = httpBankConfig(cfg(env), { httpToken: 't' }, env);
    expect(config.consentEnabled).toBe(false);
    expect(warnings[0]).toMatch(/ignored over HTTP/);
  });

  it('leaves read-only HTTP instances unchanged', () => {
    const { config, warnings } = httpBankConfig(cfg({}), {}, {});
    expect(config.consentEnabled).toBe(false);
    expect(warnings).toEqual([]);
  });
});
