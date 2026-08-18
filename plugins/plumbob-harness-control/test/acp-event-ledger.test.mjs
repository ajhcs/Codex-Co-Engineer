import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ACP_EVENT_LEDGER_LIMITS,
  AcpEventLedgerError,
  openAcpEventLedger,
} from '../mcp/acp-event-ledger.mjs';

async function stateFixture(context, prefix = 'codex-acp-events-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(root, 0o700);
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function event(index, overrides = {}) {
  void index;
  return { type: 'text', status: 'running', ...overrides };
}

function paths(root, sessionId) {
  const session = path.join(root, 'acp-events', sessionId);
  return { session, file: path.join(session, 'events.ndjson') };
}

test('provisions owner-only state and appends fsynced canonical compact events', async (context) => {
  const root = await stateFixture(context);
  const sessionId = 'managed-session-001';
  const ledger = await openAcpEventLedger({ state_root: root, session_id: sessionId });
  context.after(() => ledger.close());

  const first = await ledger.append(event(1));
  assert.equal(first.event.seq, 1);
  assert.equal(first.event_count, 1);
  assert.equal(first.event_bytes, Buffer.byteLength(`${JSON.stringify(first.event)}\n`));
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  const location = paths(root, sessionId);
  for (const directory of [root, path.join(root, 'acp-events'), location.session]) {
    assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  }
  const fileStat = await lstat(location.file);
  assert.equal(fileStat.mode & 0o7777, 0o600);
  assert.equal(fileStat.nlink, 1);
  assert.equal(await readFile(location.file, 'utf8'), `${JSON.stringify(first.event)}\n`);

  const inspected = await ledger.inspect({ expected: {
    event_count: first.event_count,
    event_bytes: first.event_bytes,
    last_seq: first.last_seq,
    digest: first.digest,
  } });
  assert.deepEqual(inspected, {
    session_id: sessionId,
    event_count: 1,
    event_bytes: first.event_bytes,
    last_seq: 1,
    digest: first.digest,
  });
  assert.doesNotMatch(JSON.stringify(first), /acp-events|events\.ndjson|grok|cursor|\/tmp/u);
});

test('serializes concurrent appends with a strict gap-free sequence', async (context) => {
  const root = await stateFixture(context);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: 'concurrent-session' });
  context.after(() => ledger.close());
  const secondHandle = await openAcpEventLedger({ state_root: root, session_id: 'concurrent-session' });
  context.after(() => secondHandle.close());
  const results = await Promise.all(Array.from({ length: 250 }, (_, index) => (
    (index % 2 === 0 ? ledger : secondHandle).append(event(index))
  )));
  assert.deepEqual(results.map((result) => result.event.seq), Array.from({ length: 250 }, (_, index) => index + 1));
  const page1 = await ledger.page({ after_seq: 0, max_events: 200, max_bytes: 64 * 1024 });
  const page2 = await ledger.page({ after_seq: page1.next_seq, max_events: 200, max_bytes: 64 * 1024 });
  assert.equal(page1.next_seq, 200);
  assert.equal(page1.has_more, true);
  assert.equal(page2.next_seq, 250);
  assert.equal(page2.has_more, false);
  assert.deepEqual([...page1.events, ...page2.events].map(({ seq }) => seq), Array.from({ length: 250 }, (_, index) => index + 1));
});

test('10k append flood stops exactly at the 2,000-event durable ceiling', async (context) => {
  const root = await stateFixture(context);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: 'flooded-session' });
  context.after(() => ledger.close());
  const attempts = await Promise.allSettled(
    Array.from({ length: 10_000 }, (_, index) => ledger.append(event(index))),
  );
  const fulfilled = attempts.filter(({ status }) => status === 'fulfilled');
  const rejected = attempts.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, ACP_EVENT_LEDGER_LIMITS.events);
  assert.equal(rejected.length, 8_000);
  assert.ok(rejected.every(({ reason }) => reason instanceof AcpEventLedgerError && reason.code === 'event_limit'));
  assert.equal((await ledger.inspect()).event_count, ACP_EVENT_LEDGER_LIMITS.events);
});

test('fixed record ceiling guarantees byte-bounded page progress without skipping', async (context) => {
  const root = await stateFixture(context);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: 'paging-session' });
  context.after(() => ledger.close());
  const appended = [];
  for (let index = 0; index < 8; index += 1) appended.push((await ledger.append(event(index))).event);
  await assert.rejects(
    ledger.page({ after_seq: 0, max_events: 200, max_bytes: ACP_EVENT_LEDGER_LIMITS.record_bytes - 1 }),
    { code: 'invalid_page' },
  );

  const seen = [];
  let cursor = 0;
  do {
    const page = await ledger.page({ after_seq: cursor, max_events: 2, max_bytes: ACP_EVENT_LEDGER_LIMITS.record_bytes });
    assert.ok(page.page_bytes <= ACP_EVENT_LEDGER_LIMITS.record_bytes);
    assert.ok(page.events.length > 0, 'a valid bounded page must always advance while more events exist');
    seen.push(...page.events.map(({ seq }) => seq));
    assert.ok(page.next_seq >= cursor);
    cursor = page.next_seq;
    if (!page.has_more) break;
  } while (true);
  assert.deepEqual(seen, appended.map(({ seq }) => seq));
});

test('rejects symlink, hardlink, and post-open path replacement attacks', async (context) => {
  const symlinkRoot = await stateFixture(context, 'codex-acp-event-symlink-');
  const symlinkLocation = paths(symlinkRoot, 'symlink-session');
  await mkdir(symlinkLocation.session, { recursive: true, mode: 0o700 });
  await chmod(path.join(symlinkRoot, 'acp-events'), 0o700);
  await chmod(symlinkLocation.session, 0o700);
  const target = path.join(symlinkRoot, 'target');
  await writeFile(target, '', { mode: 0o600 });
  await symlink(target, symlinkLocation.file);
  await assert.rejects(
    openAcpEventLedger({ state_root: symlinkRoot, session_id: 'symlink-session' }),
    (error) => error instanceof AcpEventLedgerError && error.code === 'unsafe_event_file',
  );

  const hardlinkRoot = await stateFixture(context, 'codex-acp-event-hardlink-');
  const hardlinkLocation = paths(hardlinkRoot, 'hardlink-session');
  await mkdir(hardlinkLocation.session, { recursive: true, mode: 0o700 });
  await chmod(path.join(hardlinkRoot, 'acp-events'), 0o700);
  await chmod(hardlinkLocation.session, 0o700);
  const original = path.join(hardlinkRoot, 'original');
  await writeFile(original, '', { mode: 0o600 });
  await link(original, hardlinkLocation.file);
  await assert.rejects(
    openAcpEventLedger({ state_root: hardlinkRoot, session_id: 'hardlink-session' }),
    (error) => error instanceof AcpEventLedgerError && error.code === 'unsafe_event_file',
  );

  const replacementRoot = await stateFixture(context, 'codex-acp-event-replace-');
  const replacementId = 'replace-session';
  const ledger = await openAcpEventLedger({ state_root: replacementRoot, session_id: replacementId });
  context.after(() => ledger.close());
  await ledger.append(event(1));
  const location = paths(replacementRoot, replacementId);
  await rename(location.file, `${location.file}.old`);
  await writeFile(location.file, '', { mode: 0o600 });
  await assert.rejects(
    ledger.append(event(2)),
    (error) => error instanceof AcpEventLedgerError && error.code === 'identity_changed',
  );
});

test('fails closed on truncation, partial JSON, invalid UTF-8, and canonical-content tamper', async (context) => {
  for (const [name, mutate] of [
    ['truncated-session', async (file) => writeFile(file, '', { mode: 0o600 })],
    ['partial-session', async (file) => appendFile(file, '{"seq":2')],
    ['utf8-session', async (file) => appendFile(file, Buffer.from([0xff, 0x0a]))],
    ['tampered-session', async (file) => writeFile(file, '{"type":"text","seq":1,"status":"running"}\n', { mode: 0o600 })],
  ]) {
    const root = await stateFixture(context, `codex-acp-event-${name}-`);
    const ledger = await openAcpEventLedger({ state_root: root, session_id: name });
    context.after(() => ledger.close());
    await ledger.append(event(1));
    await mutate(paths(root, name).file);
    await assert.rejects(
      ledger.page({ after_seq: 0 }),
      (error) => error instanceof AcpEventLedgerError
        && ['event_tampered', 'event_sequence'].includes(error.code),
      name,
    );
  }
});

test('rejects every free-form provider field including secrets, paths, raw JSON, and tool args', async (context) => {
  const root = await stateFixture(context);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: 'sanitized-session' });
  context.after(() => ledger.close());
  const hostile = [
    { type: 'text', status: 'running', prompt: 'do the private thing' },
    { type: 'tool', status: 'running', tool_args: { dangerous: true } },
    { type: 'control', status: 'running', jsonrpc: '2.0' },
    event(1, { text: 'read /private/repository/secret.txt' }),
    event(1, { text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
    event(1, { raw_json: '{"jsonrpc":"2.0","params":{"secret":true}}' }),
    event(1, { provider_id: 'grok-local-acp' }),
  ];
  for (const value of hostile) {
    await assert.rejects(
      ledger.append(value),
      (error) => error instanceof AcpEventLedgerError
        && error.code === 'invalid_event',
    );
  }
  assert.equal((await ledger.inspect()).event_count, 0);
  assert.equal((await ledger.append(event(1))).event.seq, 1, 'rejected input must not poison the writer lock');
});

test('cleanup derives terminal certainty from durable events and requires exact counters', async (context) => {
  const root = await stateFixture(context);
  const sessionId = 'cleanup-session';
  const ledger = await openAcpEventLedger({ state_root: root, session_id: sessionId });
  const appended = await ledger.append(event(1));
  await assert.rejects(
    ledger.inspect({ expected: { event_count: 1, event_bytes: appended.event_bytes, last_seq: 1, digest: '0'.repeat(64) } }),
    (error) => error instanceof AcpEventLedgerError && error.code === 'counter_mismatch',
  );
  await assert.rejects(ledger.cleanup({ expected: {
    event_count: appended.event_count,
    event_bytes: appended.event_bytes,
    last_seq: appended.last_seq,
    digest: appended.digest,
  } }), { code: 'cleanup_forbidden' });
  const terminal = await ledger.append(event(2, { type: 'status', status: 'completed' }));
  const cleaned = await ledger.cleanup({
    expected: {
      event_count: terminal.event_count,
      event_bytes: terminal.event_bytes,
      last_seq: terminal.last_seq,
      digest: terminal.digest,
    },
  });
  assert.deepEqual(cleaned, { session_id: sessionId, cleaned: true });
  await assert.rejects(lstat(paths(root, sessionId).file), { code: 'ENOENT' });
});

test('an uncertain durable history can never be cleaned up', async (context) => {
  const root = await stateFixture(context);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: 'uncertain-cleanup' });
  context.after(() => ledger.close());
  await ledger.append(event(1, { type: 'status', status: 'uncertain' }));
  const terminal = await ledger.append(event(2, { type: 'status', status: 'closed' }));
  await assert.rejects(ledger.cleanup({ expected: {
    event_count: terminal.event_count,
    event_bytes: terminal.event_bytes,
    last_seq: terminal.last_seq,
    digest: terminal.digest,
  } }), { code: 'cleanup_forbidden' });
});

test('independent processes serialize through the owner-only writer lock', async (context) => {
  const root = await stateFixture(context);
  const sessionId = 'process-session';
  const moduleUrl = new URL('../mcp/acp-event-ledger.mjs', import.meta.url).href;
  const script = `
    import { openAcpEventLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = await openAcpEventLedger({ state_root: process.env.LEDGER_ROOT, session_id: process.env.LEDGER_SESSION });
    const result = await ledger.append({ type: 'status', status: 'running' });
    process.stdout.write(String(result.event.seq));
    await ledger.close();
  `;
  function child() {
    const processHandle = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, LEDGER_ROOT: root, LEDGER_SESSION: sessionId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
      processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
      processHandle.once('error', reject);
      processHandle.once('exit', (code) => code === 0 ? resolve(Number(stdout)) : reject(new Error(stderr)));
    });
  }
  const sequences = await Promise.all([child(), child()]);
  assert.deepEqual(sequences.sort((left, right) => left - right), [1, 2]);
  const ledger = await openAcpEventLedger({ state_root: root, session_id: sessionId });
  context.after(() => ledger.close());
  assert.equal((await ledger.inspect()).event_count, 2);
});

test('live lock owners are never stolen and a killed owner is recovered without a sequence gap', async (context) => {
  const root = await stateFixture(context);
  const sessionId = 'stale-lock-session';
  const ledger = await openAcpEventLedger({ state_root: root, session_id: sessionId });
  context.after(() => ledger.close());
  assert.equal((await ledger.append(event(1))).event.seq, 1);
  const lockPath = path.join(paths(root, sessionId).session, 'append.lock');
  const childScript = `
    import { constants, closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
    const statText = readFileSync('/proc/self/stat', 'utf8');
    const fields = statText.slice(statText.lastIndexOf(') ') + 2).trim().split(/\\s+/u);
    const start = fields[19];
    const fd = openSync(process.env.LOCK_PATH, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    const payload = JSON.stringify({ pid: process.pid, start, nonce: 'a'.repeat(64), dev: String(stat.dev), ino: String(stat.ino) }) + '\\n';
    writeSync(fd, payload, 0, 'utf8');
    fsyncSync(fd);
    process.stdout.write('READY\\n');
    process.on('exit', () => closeSync(fd));
    setInterval(() => {}, 1_000);
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  owner.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    let output = '';
    owner.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY\n')) resolve();
    });
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error(`lock owner exited early (${code}): ${stderr}`)));
  });
  const liveIdentity = await lstat(lockPath);
  let settled = false;
  const pending = ledger.append(event(2)).then(
    (result) => { settled = true; return result; },
    (error) => { settled = true; throw error; },
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false, 'a live matching PID/start owner must retain its lock');
  const stillLive = await lstat(lockPath);
  assert.equal(String(stillLive.dev), String(liveIdentity.dev));
  assert.equal(String(stillLive.ino), String(liveIdentity.ino));
  owner.kill('SIGKILL');
  await new Promise((resolve) => owner.once('exit', resolve));
  const recovered = await pending;
  assert.equal(recovered.event.seq, 2);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  assert.equal((await ledger.inspect()).last_seq, 2);
});
