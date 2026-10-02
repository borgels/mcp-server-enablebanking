// Validate an account registry before it is deployed:
//   npm run check:accounts -- path/to/accounts.json
// Fails on invalid IBANs, duplicate ids, and an IBAN listed under two companies.
import { AccountRegistry, maskIban } from './registry.js';

const path = process.argv[2] ?? 'accounts.json';
try {
  const registry = AccountRegistry.fromFile(path);
  for (const code of registry.codes()) {
    const company = registry.company(code);
    console.log(`${code}  ${company.name} (CVR ${company.cvr}): ${company.accounts.map(a => `${a.id}=${maskIban(a.iban)}`).join(', ') || 'no accounts'}`);
  }
  // Codes named after the file must be present (e.g. the instances you deploy).
  const missing = process.argv.slice(3).filter(code => !registry.codes().includes(code));
  if (missing.length) {
    console.error(`not in the registry: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('OK');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
