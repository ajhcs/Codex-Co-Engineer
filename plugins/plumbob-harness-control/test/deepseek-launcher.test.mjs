import assert from 'node:assert/strict';
import test from 'node:test';
import { targetPatch } from '../mcp/deepseek-launcher.mjs';

test('target-aware DeepSeek overlay rewrites only the backend workspace', () => {
  const template = [
    '- id: mcp-prime-lab',
    '  config:',
    '    args:',
    '      - --workspace',
    '      - /default/repo',
    '    cwd: /default/repo',
  ].join('\n');
  const patched = targetPatch(template, '/tmp/other repo/checkout');
  assert.match(patched, /"\/tmp\/other repo\/checkout"/);
  assert.match(patched, /cwd: "\/tmp\/other repo\/checkout"/);
  assert.doesNotMatch(patched, /default\/repo/);
});
