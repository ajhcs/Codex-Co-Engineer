import assert from 'node:assert/strict';
import test from 'node:test';

import { redactText, redactValue } from '../mcp/redaction.mjs';

test('redacts structured credential keys, env assignments, and common token forms', () => {
  const secrets = {
    model: 'env-model-value-1234567890',
    cursor: 'env-cursor-value-1234567890',
    xai: 'env-xai-value-1234567890',
    bareToken: 'structured-token-value-1234567890',
    bareBearer: 'structured-bearer-value-1234567890',
    sk: ['sk', 'live-token-value-1234567890'].join('-'),
    xaiToken: ['xai', 'live-token-value-1234567890'].join('-'),
    github: ['ghp', 'live-token-value-1234567890'].join('_'),
    aws: 'AKIA1234567890ABCDEF',
  };
  const assignments = [
    ['MODEL_API_KEY', secrets.model].join('='),
    ['CURSOR_API_KEY', secrets.cursor].join(': '),
    ['XAI_API_KEY', secrets.xai].join(' = '),
    ['Authorization', ['Bearer', secrets.bareBearer].join(' ')].join(': '),
    ['token', secrets.bareToken].join('='),
  ].join('\n');
  const safe = redactValue({
    message: `${assignments}\n${secrets.sk} ${secrets.xaiToken} ${secrets.github} ${secrets.aws}`,
    MODEL_API_KEY: secrets.model,
    token: secrets.bareToken,
    bearer: secrets.bareBearer,
    nested: { CURSOR_API_KEY: secrets.cursor, XAI_API_KEY: secrets.xai },
  });
  const serialized = JSON.stringify(safe);

  for (const secret of Object.values(secrets)) assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  assert.equal(safe.MODEL_API_KEY, '[REDACTED]');
  assert.equal(safe.token, '[REDACTED]');
  assert.equal(safe.bearer, '[REDACTED]');
  assert.equal(safe.nested.CURSOR_API_KEY, '[REDACTED]');
  assert.equal(safe.nested.XAI_API_KEY, '[REDACTED]');
});

test('redacts common token forms from plain text without a secret list', () => {
  const text = [
    ['sk', 'live-token-value-1234567890'].join('-'),
    ['xai', 'live-token-value-1234567890'].join('-'),
    ['ghp', 'live-token-value-1234567890'].join('_'),
    'AKIA1234567890ABCDEF',
  ].join(' ');
  const safe = redactText(text);
  assert.doesNotMatch(safe, /sk-live-token|xai-live-token|ghp_live-token|AKIA1234567890/iu);
  assert.match(safe, /\[REDACTED_TOKEN\]/u);
});
