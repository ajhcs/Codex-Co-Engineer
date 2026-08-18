import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AcpStoreError,
  compactAcpSession,
  cleanupAcpSessions,
  getStoredAcpSession,
  insertAcpSession,
  insertAcpTurn,
  listStoredAcpTurns,
  markAcpSessionUncertain,
  openStore,
  recordAcpSessionEvent,
  markAcpTurnUncertain,
  transitionAcpSession,
  transitionAcpTurn,
  updateAcpSession,
} from '../mcp/store.mjs';

async function fixture(context, prefix = 'codex-co-engineer-acp-store-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sessionInput(overrides = {}) {
  return {
    provider: 'grok-local-acp',
    profile: 'review',
    target_fingerprint: `sha256:${'a'.repeat(64)}`,
    target_context: {
      working_directory: '/private/worktree',
      role: 'review',
    },
    effective_configuration: {
      model: 'grok-4.6',
      role: 'review',
    },
    acpx_record_id: 'acpx-record-1',
    worker_pid: process.pid,
    provider_pid: process.pid,
    capability_version: 'acp-1',
    provider_version: 'provider-1',
    session_store_dir: null,
    event_file: null,
    ttl_seconds: 300,
    request_id: 'acp-request-1',
    request_fingerprint: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

async function provisionAcpPaths(root, name = 'acp-session') {
  const sessionStoreDir = path.join(root, name);
  const eventFile = path.join(sessionStoreDir, 'events.ndjson');
  await mkdir(sessionStoreDir, { mode: 0o700 });
  await chmod(sessionStoreDir, 0o700);
  await writeFile(eventFile, '', { mode: 0o600 });
  await chmod(eventFile, 0o600);
  return { session_store_dir: sessionStoreDir, event_file: eventFile };
}

test('ACP schema migration is additive and idempotent across store reopen', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-migration-');
  const file = path.join(directory, 'control.sqlite3');
  const first = openStore(file);
  const created = insertAcpSession(first, sessionInput({ id: 'managed-session-1' }));
  const before = getStoredAcpSession(first, created.id);
  const columnsBefore = first.prepare('PRAGMA table_info(acp_sessions)').all().map((row) => row.name);
  first.close();

  const second = openStore(file);
  const after = getStoredAcpSession(second, created.id);
  const columnsAfter = second.prepare('PRAGMA table_info(acp_sessions)').all().map((row) => row.name);
  assert.deepEqual(after, before);
  assert.deepEqual(columnsAfter, columnsBefore);
  assert.ok(columnsAfter.includes('state'));
  assert.ok(columnsAfter.includes('event_cursor'));
  assert.ok(columnsAfter.includes('event_bytes'));
  assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'acp_turns'").get());
  second.close();
});

test('ACP request IDs deduplicate only an exact request fingerprint', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-dedupe-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());

  const first = insertAcpSession(database, sessionInput({ id: 'managed-session-2' }));
  const duplicate = insertAcpSession(database, sessionInput({
    id: 'a-different-managed-id',
    request_id: 'acp-request-1',
    request_fingerprint: `sha256:${'b'.repeat(64)}`,
  }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);

  assert.throws(
    () => insertAcpSession(database, sessionInput({ request_fingerprint: `sha256:${'c'.repeat(64)}` })),
    (error) => error instanceof AcpStoreError
      && error.code === 'request_id_conflict'
      && /fingerprint/.test(error.message),
  );

  markAcpSessionUncertain(database, first.id, { reason: 'provider response was lost' });
  const replay = insertAcpSession(database, sessionInput({ id: 'another-id' }));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.session.state, 'uncertain');
  assert.deepEqual(JSON.parse(replay.session.uncertainty), { reason: 'provider response was lost' });
});

test('ACP session and turn transitions are conditional and reject illegal paths', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-transitions-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());

  const session = insertAcpSession(database, sessionInput({
    id: 'managed-session-3',
    request_id: 'acp-request-3',
    request_fingerprint: `sha256:${'d'.repeat(64)}`,
  }));
  assert.throws(
    () => transitionAcpSession(database, session.id, 'closed'),
    /Invalid ACP session transition creating -> closed/,
  );
  const provisioned = await provisionAcpPaths(directory, 'managed-session-3-state');
  updateAcpSession(database, session.id, provisioned);
  assert.equal(transitionAcpSession(database, session.id, 'ready').changed, true);
  assert.throws(
    () => transitionAcpSession(database, session.id, 'creating'),
    /Invalid ACP session transition ready -> creating/,
  );

  const turn = insertAcpTurn(database, session.id, {
    id: 'managed-turn-1',
    request_id: 'turn-request-1',
    request_fingerprint: `sha256:${'e'.repeat(64)}`,
  });
  assert.equal(transitionAcpTurn(database, turn.id, 'prompting').changed, true);
  assert.throws(
    () => transitionAcpTurn(database, turn.id, 'creating'),
    /Invalid ACP turn transition prompting -> creating/,
  );
  assert.equal(transitionAcpTurn(database, turn.id, 'uncertain').changed, true);
  assert.throws(
    () => transitionAcpTurn(database, turn.id, 'prompting'),
    /Invalid ACP turn transition uncertain -> prompting/,
  );
  assert.equal(listStoredAcpTurns(database, session.id).length, 1);
});

test('compact ACP projections never expose prompt or owner-only path metadata', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-projection-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  const paths = await provisionAcpPaths(directory, 'managed-session-4-state');
  const created = insertAcpSession(database, sessionInput({ id: 'managed-session-4', ...paths }));
  const row = getStoredAcpSession(database, created.id);
  const compact = compactAcpSession(row);
  const serialized = JSON.stringify(compact);
  assert.equal(compact.id, 'managed-session-4');
  assert.equal(compact.state, 'creating');
  assert.doesNotMatch(serialized, /this must never be persisted|managed-session-4-state|events\.ndjson/i);
  assert.equal(Object.hasOwn(compact, 'target_context'), false);
  assert.equal(Object.hasOwn(compact, 'effective_configuration'), false);
  assert.equal(Object.hasOwn(compact, 'session_store_dir'), false);
  assert.equal(Object.hasOwn(compact, 'event_file'), false);
  assert.equal(Object.hasOwn(compact, 'target_fingerprint'), false);
  assert.equal(Object.hasOwn(compact, 'request_fingerprint'), false);
  assert.equal(row.effective_configuration.includes('prompt'), false);
  assert.equal(row.target_context.includes('/private/worktree'), true);
});

test('ACP state paths fail closed unless they are contained owner-only single-link state objects', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-paths-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());

  const unprovisioned = insertAcpSession(database, sessionInput({
    id: 'unprovisioned-session',
    request_id: 'unprovisioned-request',
    request_fingerprint: `sha256:${'7'.repeat(64)}`,
  }));
  assert.throws(
    () => transitionAcpSession(database, unprovisioned.id, 'ready'),
    /must be securely provisioned before the session can become usable/,
  );

  const outside = await fixture(context, 'codex-co-engineer-acp-outside-');
  const outsidePaths = await provisionAcpPaths(outside);
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      id: 'outside-session', request_id: 'outside-request',
      request_fingerprint: `sha256:${'8'.repeat(64)}`, ...outsidePaths,
    })),
    /contained beneath the durable state root/,
  );

  const permissive = await provisionAcpPaths(directory, 'permissive-state');
  await chmod(permissive.session_store_dir, 0o1700);
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      id: 'special-mode-session', request_id: 'special-mode-request',
      request_fingerprint: `sha256:${'9'.repeat(64)}`, ...permissive,
    })),
    /exact owner-only mode 0700/,
  );

  const target = await provisionAcpPaths(directory, 'real-state');
  const linkedDirectory = path.join(directory, 'linked-state');
  await symlink(target.session_store_dir, linkedDirectory);
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      id: 'symlink-session', request_id: 'symlink-request',
      request_fingerprint: `sha256:${'a'.repeat(64)}`,
      session_store_dir: linkedDirectory,
      event_file: path.join(linkedDirectory, 'events.ndjson'),
    })),
    /real directories/,
  );

  const hardlinkState = path.join(directory, 'hardlink-state');
  await mkdir(hardlinkState, { mode: 0o700 });
  await chmod(hardlinkState, 0o700);
  const hardlinkEvent = path.join(hardlinkState, 'events.ndjson');
  await link(target.event_file, hardlinkEvent);
  assert.equal((await lstat(hardlinkEvent)).nlink, 2);
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      id: 'hardlink-session', request_id: 'hardlink-request',
      request_fingerprint: `sha256:${'c'.repeat(64)}`,
      session_store_dir: hardlinkState, event_file: hardlinkEvent,
    })),
    /exactly one filesystem link/,
  );
});

test('request IDs are globally fenced across session/turn kinds and uncertainty fences turns', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-global-dedupe-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  const first = insertAcpSession(database, sessionInput({
    id: 'managed-session-global',
    request_id: 'global-request',
    request_fingerprint: `sha256:${'1'.repeat(64)}`,
  }));
  updateAcpSession(database, first.id, await provisionAcpPaths(directory, 'managed-session-global-state'));
  transitionAcpSession(database, first.id, 'ready');
  const turn = insertAcpTurn(database, first.id, {
    request_id: 'global-turn-request',
    request_fingerprint: `sha256:${'2'.repeat(64)}`,
  });
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      request_id: 'global-turn-request',
      request_fingerprint: `sha256:${'2'.repeat(64)}`,
    })),
    /session and turn request identities cannot be reused/,
  );
  assert.throws(
    () => insertAcpTurn(database, first.id, {
      request_id: 'global-request',
      request_fingerprint: `sha256:${'1'.repeat(64)}`,
    }),
    /session and turn request identities cannot be reused/,
  );

  const uncertain = markAcpTurnUncertain(database, turn.id, { code: 'transport_lost' });
  assert.equal(uncertain.turn.state, 'uncertain');
  assert.equal(uncertain.session.state, 'uncertain');
  assert.throws(
    () => insertAcpTurn(database, first.id, {
      request_id: 'new-turn-request',
      request_fingerprint: `sha256:${'3'.repeat(64)}`,
    }),
    /new turns require an explicitly ready session/,
  );
});

test('ACP metadata, fingerprints, and counters fail closed before SQLite', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-adversarial-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  assert.throws(
    () => insertAcpSession(database, sessionInput({
      effective_configuration: { prompt: 'never persist' },
    })),
    /unsupported metadata member prompt/,
  );
  assert.throws(
    () => insertAcpSession(database, sessionInput({ request_fingerprint: 'not-a-digest' })),
    /exact SHA-256 digest/,
  );
  const created = insertAcpSession(database, sessionInput({ id: 'managed-session-overflow' }));
  database.prepare('UPDATE acp_sessions SET event_count = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER, created.id);
  assert.throws(
    () => recordAcpSessionEvent(database, created.id, { count: 1 }),
    /safe integer bound/,
  );
});

test('cleanup selects only expired closed sessions without uncertainty or process owners', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-cleanup-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  const eligible = insertAcpSession(database, sessionInput({
    id: 'cleanup-eligible',
    ttl_seconds: 1,
    worker_pid: null,
    provider_pid: null,
  }));
  updateAcpSession(database, eligible.id, await provisionAcpPaths(directory, 'cleanup-eligible-state'));
  transitionAcpSession(database, eligible.id, 'ready');
  transitionAcpSession(database, eligible.id, 'closed');
  const active = insertAcpSession(database, sessionInput({
    id: 'cleanup-active',
    request_id: 'cleanup-active-request',
    request_fingerprint: `sha256:${'4'.repeat(64)}`,
    ttl_seconds: 1,
  }));
  assert.equal(cleanupAcpSessions(database, '2999-01-01T00:00:00.000Z').deleted, 1);
  assert.equal(getStoredAcpSession(database, eligible.id), null);
  assert.equal(getStoredAcpSession(database, active.id).state, 'creating');
});

test('TTL updates recompute expiry and reject inconsistent or overflowing dates', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-ttl-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  const created = insertAcpSession(database, sessionInput({
    id: 'ttl-session',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ttl_seconds: 60,
  }));
  const updated = updateAcpSession(database, created.id, { ttl_seconds: 120 });
  assert.equal(updated.expires_at, '2026-01-01T00:02:00.000Z');
  assert.throws(
    () => updateAcpSession(database, created.id, { expires_at: '2026-01-01T00:03:00.000Z' }),
    /must equal created_at plus ttl_seconds/,
  );
  assert.throws(
    () => insertAcpSession(database, sessionInput({ ttl_seconds: Number.MAX_SAFE_INTEGER })),
    /supported date range/,
  );
});

test('ACP authority fields are immutable, with one-time secure path provisioning', async (context) => {
  const directory = await fixture(context, 'codex-co-engineer-acp-authority-');
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());
  const created = insertAcpSession(database, sessionInput({
    id: 'authority-session',
    acpx_record_id: null,
  }));
  for (const patch of [
    { provider: 'other-provider' },
    { profile: 'implement' },
    { target_fingerprint: `sha256:${'f'.repeat(64)}` },
    { target_context: { role: 'implement' } },
  ]) {
    assert.throws(
      () => updateAcpSession(database, created.id, patch),
      /authority field .*cannot change/,
    );
  }
  const paths = await provisionAcpPaths(directory, 'authority-state');
  const provisioned = updateAcpSession(database, created.id, {
    acpx_record_id: 'acpx-provisioned',
    ...paths,
  });
  assert.equal(provisioned.acpx_record_id, 'acpx-provisioned');
  assert.equal(provisioned.session_store_dir, paths.session_store_dir);
  assert.throws(
    () => updateAcpSession(database, created.id, { acpx_record_id: 'acpx-swapped' }),
    /cannot change after provisioning/,
  );
  assert.throws(
    () => updateAcpSession(database, created.id, { ...paths, event_file: path.join(paths.session_store_dir, 'other.ndjson') }),
    /cannot change after provisioning|invalid_acp_state_path/,
  );
  assert.throws(
    () => database.prepare('UPDATE acp_sessions SET provider = ? WHERE id = ?').run('sql-bypass', created.id),
    /immutable/,
  );
});
