import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SERVER = fileURLToPath(new URL('../mcp/v3/server.mjs', import.meta.url));

async function withClient(capabilities, formResult, exercise) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'co-engineer-consent-roundtrip-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'README.md'), 'Synthetic consent fixture.\n');
  git('add', 'README.md');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture');
  const sha = git('rev-parse', 'HEAD').toString().trim();
  const child = spawn(process.execPath, ['--no-warnings', SERVER, '--stdio'], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      // An accepted form must stop before real workspaces or provider jobs.
      XDG_RUNTIME_DIR: path.join(root, 'unavailable-runtime'),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, 'absent-bus')}`,
      CODEX_CO_ENGINEER_STATE_DIR: path.join(root, 'receipts'),
      CODEX_CO_ENGINEER_GROK_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_ACPX_COMMAND: '/bin/false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const forms = [];
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2048); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'elicitation/create') {
      forms.push(message);
      const result = typeof formResult === 'function' ? formResult(forms.length) : formResult;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    item.resolve(message);
  });
  child.once('exit', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`Server exited: ${stderr}`));
    }
    pending.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}; ${stderr}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: { ...args, response_mode: 'structured' } });
    assert.equal(response.error, undefined);
    assert.ok(response.result?.structuredContent, JSON.stringify(response.result));
    return response.result.structuredContent;
  };
  try {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'fixture', version: '1' } });
    await exercise({ repo, sha, forms, call });
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  }
}

function submission(repo) {
  return { run_request: {
    run_id: 'native-consent-roundtrip', repo,
    objective: 'Exercise native consent without launching a provider.',
    assignments: [{ assignment_id: 'review', provider: 'cursor-local', role: 'review', prompt: 'Review the synthetic README.', expected_duration_ms: 60000 }],
  } };
}

function noDispatch(receipt) {
  assert.equal(receipt.side_effects.provider_dispatched, false);
  assert.equal(receipt.authoritative_required_dispatch, false);
  assert.ok(receipt.lanes.every((lane) => !lane.prepared && !lane.prompt_dispatched));
}

for (const [action, approved] of [['decline', false], ['cancel', false], ['accept', false], ['accept', 'true']]) {
  test(`stdio native form ${action}/${approved} never approves repository exposure`, async () => {
    await withClient({ elicitation: { form: {} } }, { action, content: { approved } }, async ({ repo, forms, call }) => {
      const receipt = await call('delegate', submission(repo));
      assert.equal(forms.length, 1);
      assert.notEqual(receipt.consent.status, 'approved');
      noDispatch(receipt);
      const inspected = await call('task', { run_id: receipt.run_id, wait_until: 'decision_or_attention', wait_ms: 0 });
      assert.equal(inspected.run_id, receipt.run_id);
      assert.equal(inspected.phase, receipt.phase);
      assert.equal(forms.length, 1, 'inspection must not request another form');
    });
  });
}

test('stdio native acceptance crosses consent and stops at the isolated readiness barrier', async () => {
  await withClient({ elicitation: { form: {} } }, { action: 'accept', content: { approved: true } }, async ({ repo, sha, forms, call }) => {
    const receipt = await call('delegate', submission(repo));
    assert.equal(forms.length, 1);
    const form = forms[0].params;
    assert.ok(form.message.includes(repo));
    assert.ok(form.message.includes(sha));
    assert.equal(form.requestedSchema.properties.approved.type, 'boolean');
    assert.ok(form.requestedSchema.required.includes('approved'));
    assert.equal(receipt.consent.status, 'approved');
    assert.equal(receipt.phase, 'failed');
    assert.equal(receipt.telemetry.admission_failure_stage, 'readiness');
    noDispatch(receipt);
    const inspected = await call('status', { run_id: receipt.run_id });
    assert.equal(inspected.run_id, receipt.run_id);
    assert.equal(inspected.phase, 'failed');
    assert.equal(forms.length, 1);
  });
});

test('stdio host without form capability gives an explicit blocker without elicitation', async () => {
  await withClient({}, null, async ({ repo, forms, call }) => {
    const receipt = await call('delegate', submission(repo));
    assert.equal(forms.length, 0);
    assert.equal(receipt.error.code, 'consent_host_unavailable');
    assert.equal(receipt.complete_candidate_blocked, true);
    noDispatch(receipt);
  });
});

test('a dismissed form can be reopened explicitly on the same run', async () => {
  const response = (attempt) => attempt === 1
    ? { action: 'cancel' }
    : { action: 'accept', content: { approved: true } };
  await withClient({ elicitation: { form: {} } }, response, async ({ repo, forms, call }) => {
    const pending = await call('delegate', submission(repo));
    assert.equal(pending.phase, 'awaiting_consent');
    noDispatch(pending);
    const resumed = await call('task', {
      run_id: pending.run_id, run_reply: { request_consent: true },
    });
    assert.equal(forms.length, 2);
    assert.equal(resumed.run_id, pending.run_id);
    assert.equal(resumed.consent.status, 'approved');
    assert.equal(resumed.telemetry.admission_failure_stage, 'readiness');
    noDispatch(resumed);
  });
});
