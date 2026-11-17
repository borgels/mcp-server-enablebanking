import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('npm pack', () => {
  it('ships the gateway build with its types and nothing private', () => {
    if (!existsSync(new URL('../dist/gateway.js', import.meta.url)) || !existsSync(new URL('../dist/gateway.d.ts', import.meta.url))) {
      execSync('npm run build', { cwd: root, stdio: 'ignore' });
    }
    const output = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8' });
    const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const files = pack!.files.map(file => file.path.split(String.fromCharCode(92)).join('/'));
    for (const required of ['dist/gateway.js', 'dist/gateway.d.ts', 'dist/transports/stdio.js', 'dist/transports/http.js', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
      expect(files).toContain(required);
    }
    for (const file of files) {
      expect(file).not.toMatch(/^(src|test|deploy|node_modules|\.github)\//);
      expect(file).not.toMatch(/(^|\/)\.env$|\.pem$/);
    }
  }, 120_000);

  it('exports ./gateway with types', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./gateway']).toEqual({ types: './dist/gateway.d.ts', default: './dist/gateway.js' });
    expect(pkg.exports['.']).toBe('./dist/transports/stdio.js');
  });
});
