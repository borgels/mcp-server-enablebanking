#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../enablebanking/config.js';
import { createBank, createServer } from '../server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({
    bank: createBank(config),
    config,
    actingAs: process.env.ENABLEBANKING_DEFAULT_USER ?? 'local',
  });
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
