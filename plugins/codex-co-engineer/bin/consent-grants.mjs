#!/usr/bin/env node

import { createConsentGrantStore } from '../mcp/v3/consent-grants.mjs';
import { stateRoot } from '../mcp/v3/task-store.mjs';

function usage() {
  return [
    'Usage:',
    '  codex-co-engineer-consent list',
    '  codex-co-engineer-consent revoke --repo /absolute/path/to/repository',
    '  codex-co-engineer-consent revoke --grant-id 64_HEX_CHARACTERS',
  ].join('\n');
}

function fail(message) {
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exitCode = 2;
}

async function main(argv) {
  const [command, option, value, ...extra] = argv;
  if (extra.length > 0 || !['list', 'revoke'].includes(command)) return fail('Unknown consent command.');
  const store = createConsentGrantStore({ root: stateRoot() });
  if (command === 'list') {
    if (option !== undefined) return fail('The list command takes no arguments.');
    const grants = await store.list();
    if (grants.length === 0) {
      process.stdout.write('No remembered repository consent grants.\n');
      return;
    }
    for (const grant of grants) {
      process.stdout.write([
        grant.grant_id,
        `  repository: ${grant.repository}`,
        `  origin: ${grant.origin ?? '(none)'}`,
        `  providers: ${grant.providers.join(', ')}`,
        `  granted: ${grant.granted_at}`,
      ].join('\n') + '\n');
    }
    return;
  }
  if (value === undefined || (option !== '--repo' && option !== '--grant-id')) {
    return fail('Revoke requires --repo or --grant-id.');
  }
  const revoked = await store.revoke(option === '--repo'
    ? { repositoryPath: value }
    : { grantId: value });
  process.stdout.write(revoked ? 'Consent grant revoked.\n' : 'No matching consent grant.\n');
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Consent grant command failed: ${error?.code ?? 'unknown_error'}: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
