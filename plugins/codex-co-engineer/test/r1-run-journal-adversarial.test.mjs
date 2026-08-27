import assert from 'node:assert/strict';
import { chmod, lstat, readFile, readdir, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_RUN_JOURNAL_CHILDREN,
  RUN_JOURNAL_ENTRY_SCHEMA_ID,
  RUN_JOURNAL_EVENT_KINDS,
  RUN_JOURNAL_GENESIS_PREV,
  RUN_JOURNAL_OUTCOMES,
  applyRunJournalEntryV1,
  emptyRunJournalStateV1,
  reduceRunJournalEntriesV1,
  validateRunJournalEventDataV1,
} from '../mcp/v3/run-reducer.mjs';
import {
  RUN_JOURNAL_CURSOR_DOMAIN,
  RUN_JOURNAL_LOCK_SCHEMA_ID,
  createRunJournal,
  openRunJournal,
  validateBoundRunRecord,
} from '../mcp/v3/run-journal.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { openRunStore } from '../mcp/v3/run-store.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import {
  makePrivateRoot,
  makeSubmission,
} from './fixtures/r1-run-store-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

async function withJournal(fn, { runId = 'run-journal-hostile' } = {}) {
  const storeRoot = await makePrivateRoot('r1-p25-adv-store-');
  const journalRoot = await makePrivateRoot('r1-p25-adv-root-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId }));
    const journal = await createRunJournal({ root: journalRoot, store, run_id: runId });
    return await fn({ store, storeRoot, journalRoot, runId, journal });
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
}

async function primeChild(journal) {
  await journal.append({ kind: 'run_opened', data: {} });
  await journal.append({ kind: 'child_started', data: { assignment_id: 'a0' } });
}

// Deterministic PRNG so the hostile lattice is reproducible.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference oracle for the transition lattice.
function makeOracle() {
  const children = new Map();
  let opened = false;
  let terminal = false;
  return {
    get terminal() { return terminal; },
    legal(kind, data) {
      if (terminal) return false;
      if (kind === 'run_opened') return !opened;
      if (!opened) return false;
      if (kind === 'run_terminal') {
        return children.size >= 1 && [...children.values()].every((value) => value !== null);
      }
      const id = data.assignment_id;
      const current = children.get(id);
      if (kind === 'child_started') {
        if (current !== undefined) return false;
        return children.size < MAX_RUN_JOURNAL_CHILDREN;
      }
      if (current === undefined || current !== null) return false;
      return true;
    },
    apply(kind, data) {
      if (kind === 'run_opened') opened = true;
      else if (kind === 'child_started') children.set(data.assignment_id, null);
      else if (kind === 'child_terminal') children.set(data.assignment_id, data.outcome);
      else if (kind === 'run_terminal') terminal = true;
    },
  };
}

function candidateBodies(random, childIds) {
  const bodies = [];
  bodies.push({ kind: 'run_opened', data: {} });
  for (const kind of ['child_started', 'child_progress', 'child_artifact', 'child_terminal']) {
    for (const id of childIds) {
      if (kind === 'child_started') bodies.push({ kind, data: { assignment_id: id } });
      else if (kind === 'child_progress') {
        bodies.push({ kind, data: { assignment_id: id, note: 'progress.tick' } });
      } else if (kind === 'child_artifact') {
        bodies.push({
          kind,
          data: { assignment_id: id, artifact: { digest: `sha256:${'a'.repeat(64)}`, bytes: 8 } },
        });
      } else {
        bodies.push({
          kind,
          data: { assignment_id: id, outcome: RUN_JOURNAL_OUTCOMES[random() * 3 | 0] },
        });
      }
    }
  }
  bodies.push({ kind: 'run_terminal', data: { outcome: 'completed' } });
  return bodies;
}

test('hostile randomized transition latches match an independent oracle across many seeds', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = mulberry32(seed);
    const childIds = ['a0', 'a1', 'a2', 'ghost'];
    const bodies = candidateBodies(random, childIds);
    const oracle = makeOracle();
    let state = emptyRunJournalStateV1();
    const accepted = [];

    for (let step = 0; step < 120; step += 1) {
      const body = bodies[random() * bodies.length | 0];
      const expected = oracle.legal(body.kind, body.data);
      let reducerAccepted = true;
      let nextState = state;
      try {
        nextState = applyRunJournalEntryV1(state, {
          schema: RUN_JOURNAL_ENTRY_SCHEMA_ID,
          seq: state.revision + 1,
          kind: body.kind,
          data: body.data,
          prev: state.head_hash,
          hash: `sha256:${String(state.revision + 1).padStart(64, 'c')}`,
        });
      } catch (error) {
        assert.ok(error instanceof RunContractV1Error);
        reducerAccepted = false;
      }
      assert.equal(reducerAccepted, expected, `seed ${seed} step ${step} ${body.kind}`);
      if (reducerAccepted) {
        state = nextState;
        accepted.push({
          schema: RUN_JOURNAL_ENTRY_SCHEMA_ID,
          seq: state.revision,
          kind: body.kind,
          data: body.data,
          prev: accepted.length === 0
            ? RUN_JOURNAL_GENESIS_PREV
            : accepted[accepted.length - 1].hash,
          hash: `sha256:${String(state.revision).padStart(64, 'c')}`,
        });
        oracle.apply(body.kind, body.data);
      }
      if (oracle.terminal) {
        assert.equal(state.terminal, true);
        assert.equal(state.run_outcome !== null, true);
      }
    }

    // Exact replay of the accepted stream reproduces the folded state.
    const replayed = reduceRunJournalEntriesV1(accepted);
    assert.equal(canonicalJsonStringify(replayed), canonicalJsonStringify(state));
    // Monotonicity invariants hold.
    let counted = 0;
    for (const kind of RUN_JOURNAL_EVENT_KINDS) counted += state.event_counts[kind];
    assert.equal(counted, state.revision);
    assert.equal(state.child_count <= MAX_RUN_JOURNAL_CHILDREN, true);
  }
});

test('closed event shapes reject hostile payloads with typed errors', () => {
  const hostiles = [
    ['unknown kind', 'teleport', {}],
    ['run_opened with payload', 'run_opened', { extra: 1 }],
    ['progress with prompt key', 'child_progress', { assignment_id: 'a0', prompt: 'leak' }],
    ['progress with free note', 'child_progress', { assignment_id: 'a0', note: 'has space' }],
    ['progress with long note', 'child_progress', { assignment_id: 'a0', note: `a${'b'.repeat(80)}` }],
    ['artifact with path', 'child_artifact', {
      assignment_id: 'a0',
      artifact: { digest: `sha256:${'a'.repeat(64)}`, bytes: 8, path: '/etc/shadow' },
    }],
    ['artifact with huge bytes', 'child_artifact', {
      assignment_id: 'a0',
      artifact: { digest: `sha256:${'a'.repeat(64)}`, bytes: 2 ** 53 },
    }],
    ['terminal unknown outcome', 'child_terminal', { assignment_id: 'a0', outcome: 'maybe' }],
    ['run_terminal unknown outcome', 'run_terminal', { outcome: 'forever' }],
    ['assignment id traversal', 'child_started', { assignment_id: '../../etc' }],
    ['assignment id uppercase', 'child_started', { assignment_id: 'A0' }],
  ];
  for (const [label, kind, data] of hostiles) {
    let code = null;
    try {
      validateRunJournalEventDataV1(kind, data);
    } catch (error) {
      assert.ok(error instanceof RunContractV1Error);
      code = error.code;
    }
    assert.notEqual(code, null, `expected rejection: ${label}`);
  }
});

test('symlinked journal surfaces fail closed without following', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    const scratch = await mkdtempScratch();
    try {
      const outside = path.join(scratch, 'outside.jsonl');
      await writeFile(outside, 'hostile\n');

      for (const [name, expected] of [
        ['journal.jsonl', 'run_journal_not_regular'],
        ['state.json', 'run_journal_not_regular'],
        // The advisory lock reader fails closed with its own typed code.
        ['lock', 'run_journal_lock_corrupt'],
        ['created.json', 'run_journal_not_regular'],
      ]) {
        const target = path.join(journal.directory, name);
        const original = await readFile(target).catch(() => null);
        const backup = path.join(scratch, `${name.replace('.', '_')}.bak`);
        if (original !== null) await writeFile(backup, original);
        await unlink(target).catch(() => {});
        await symlink(outside, target);
        const error = await errorOf(() => journal.currentState());
        assert.equal(error.code, expected, name);
        await unlink(target);
        if (original !== null) {
          await writeFile(target, original, { mode: 0o600 });
          await chmod(target, 0o600);
        }
      }

      // A symlinked sibling run directory poisons the whole root audit.
      const runsDir = path.join(path.dirname(journal.directory));
      const sibling = path.join(runsDir, 'run-journal-sibling-evil');
      await symlink(outside, sibling);
      const poisoned = await errorOf(() => journal.currentState());
      assert.equal(poisoned.code, 'run_journal_unsafe_path');
      await unlink(sibling);

      // A symlink at a temporary name is never followed.
      await symlink(outside, path.join(journal.directory, `.tmp-${'a'.repeat(32)}`));
      const tempSymlink = await errorOf(() => journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: 'progress.t' },
      }));
      assert.equal(tempSymlink.code, 'run_journal_torn_temporary');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

async function mkdtempScratch() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(tmpdir(), 'r1-p25-adv-scratch-'));
}

test('root and run-directory swaps between operations fail hard', async () => {
  await withJournal(async ({ journalRoot, runId, store, journal }) => {
    await primeChild(journal);
    // Swap the run directory for a fresh empty one.
    const dir = journal.directory;
    await rm(dir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { mode: 0o700 });
    const swapped = await errorOf(() => journal.append({
      kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.swap' },
    }));
    // A recreated directory cannot carry this binding's creation stamp, so
    // inode-reuse tricks cannot smuggle a reset journal past the handle.
    // Depending on inode reuse, identity or stamp verification fires first;
    // both are hard failures.
    assert.ok(
      swapped.code === 'run_journal_dir_rebound'
        || swapped.code === 'run_journal_root_swapped',
      `unexpected code ${swapped.code}`,
    );

    // Swap the entire root.
    await rm(journalRoot, { recursive: true, force: true });
    await mkdir(journalRoot, { mode: 0o700 });
    const rootSwapped = await errorOf(() => journal.currentState());
    assert.equal(rootSwapped.code, 'run_journal_root_swapped');

    // A brand-new handle on the emptied root reports the missing run.
    const missing = await errorOf(() => openRunJournal({ root: journalRoot, store, run_id: runId }));
    assert.equal(missing.code, 'run_journal_not_found');
  });
});

test('directory floods, foreign entries, and oversized files fail closed', async () => {
  await withJournal(async ({ journalRoot, runId, store }) => {
    const { mkdir } = await import('node:fs/promises');
    const runsDir = path.join(journalRoot, 'runs');
    for (let index = 0; index < 256; index += 1) {
      await mkdir(path.join(runsDir, `run-flood-${index}`), { mode: 0o700 });
    }
    const flooded = await errorOf(() => openRunJournal({ root: journalRoot, store, run_id: runId }));
    assert.equal(flooded.code, 'run_journal_flood');
  });

  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    await writeFile(path.join(journal.directory, 'foreign.txt'), 'nope\n');
    const foreign = await errorOf(() => journal.currentState());
    assert.equal(foreign.code, 'run_journal_foreign_entry');
  });

  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean);
    const { MAX_RUN_JOURNAL_FILE_BYTES } = await import('../mcp/v3/run-journal.mjs');
    await writeFile(journalPath, `${lines.join('\n')}\n${'x'.repeat(MAX_RUN_JOURNAL_FILE_BYTES + 1)}`);
    const oversized = await errorOf(() => journal.healTornTail());
    assert.equal(oversized.code, 'run_journal_file_too_large');
  });
});

test('malformed committed lines and foreign lock files fail hard', async () => {
  await withJournal(async ({ store, journalRoot, runId, journal }) => {
    await primeChild(journal);
    const journalPath = path.join(journal.directory, 'journal.jsonl');
    const lines = (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean);

    // Non-canonical but valid JSON in a committed line.
    const parsed = JSON.parse(lines[0]);
    const reordered = {
      hash: parsed.hash, prev: parsed.prev, data: parsed.data,
      kind: parsed.kind, seq: parsed.seq, schema: parsed.schema,
    };
    const nonCanonical = canonicalJsonStringify(reordered).replace('{"data"', '{ "data"');
    await writeFile(journalPath, `${canonicalJsonStringify(parsed)}\n${lines[1]}\n${nonCanonical}\n`);
    const malformed = await errorOf(() => journal.currentState());
    assert.equal(malformed.code, 'run_journal_committed_corruption');

    // Blank committed line.
    await writeFile(journalPath, `${lines.join('\n')}\n\n`);
    const blank = await errorOf(() => journal.currentState());
    assert.equal(blank.code, 'run_journal_committed_corruption');

    // Unknown envelope key in a committed entry.
    const extra = { ...parsed, surprise: 1 };
    await writeFile(journalPath, `${canonicalJsonStringify(extra)}\n${lines[1]}\n`);
    const unknownKey = await errorOf(() => journal.currentState());
    assert.equal(unknownKey.code, 'run_journal_committed_corruption');

    // Foreign lock content is never followed or adopted.
    await writeFile(path.join(journal.directory, 'lock'), 'garbage-lock\n');
    const lock = await errorOf(() => journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.lock' },
    }));
    assert.equal(lock.code, 'run_journal_lock_corrupt');
    await rm(path.join(journal.directory, 'lock'), { force: true });
    void store; void journalRoot; void runId;
  });
});

test('cursor hostiles: truncation, seal flips, wrong versions, extra keys, and cross-run reuse', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.p' } });
    const page = await journal.readPage({ limit: 2 });
    assert.notEqual(page.next_cursor, null);

    const hostiles = [
      ['truncated', page.next_cursor.slice(0, page.next_cursor.length - 8)],
      ['empty', ''],
      ['no seal', page.next_cursor.split('.')[0]],
      ['extra dot', `${page.next_cursor}.extra`],
      ['bad base64', `${'!'.repeat(20)}.AAAA`],
    ];
    for (const [label, token] of hostiles) {
      const error = await errorOf(() => journal.readPage({ cursor: token }));
      assert.equal(error.code, 'run_journal_cursor_invalid', label);
    }

    // Structurally valid payload with wrong version and extra key, both sealed.
    const { createHash } = await import('node:crypto');
    const seal = (text) => {
      const payload = Buffer.from(text).toString('base64url');
      const digest = createHash('sha256').update(`${RUN_JOURNAL_CURSOR_DOMAIN}\n${payload}`, 'utf8').digest();
      return `${payload}.${digest.toString('base64url')}`;
    };
    const wrongVersion = seal(canonicalJsonStringify({
      v: 2, run: journal.run_fingerprint, seq: 1, head: RUN_JOURNAL_GENESIS_PREV,
    }));
    assert.equal((await errorOf(() => journal.readPage({ cursor: wrongVersion }))).code,
      'run_journal_cursor_invalid');
    const extraKey = seal(canonicalJsonStringify({
      v: 1, run: journal.run_fingerprint, seq: 1, head: RUN_JOURNAL_GENESIS_PREV, extra: true,
    }));
    assert.equal((await errorOf(() => journal.readPage({ cursor: extraKey }))).code,
      'run_journal_cursor_invalid');
    const foreignRun = seal(canonicalJsonStringify({
      v: 1, run: 'f'.repeat(64), seq: 1, head: RUN_JOURNAL_GENESIS_PREV,
    }));
    assert.equal((await errorOf(() => journal.readPage({ cursor: foreignRun }))).code,
      'run_journal_cursor_cross_run');

    // Out-of-band limits.
    assert.equal((await errorOf(() => journal.readPage({ limit: 0 }))).code, 'invalid_format');
    assert.equal((await errorOf(() => journal.readPage({ limit: 65 }))).code, 'invalid_format');
    const stale = await errorOf(() => journal.cursorAfter(99));
    assert.equal(stale.code, 'run_journal_cursor_stale');
    const negative = await errorOf(() => journal.cursorAfter(-1));
    assert.equal(negative.code, 'invalid_format');
  });
});

test('append hostiles: unknown keys, bad expectations, and hostile dedupe keys fail before writes', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    const before = await readFile(path.join(journal.directory, 'journal.jsonl'), 'utf8');

    const cases = [
      [{ kind: 'child_progress', data: { assignment_id: 'a0', note: 'n' }, extra: 1 }, 'unknown_key'],
      [{ kind: 'child_progress' }, 'missing_key'],
      [{ kind: 'child_progress', data: { assignment_id: 'a0', note: 'n' }, expected_seq: 0 }, 'invalid_format'],
      [{ kind: 'child_progress', data: { assignment_id: 'a0', note: 'n' }, dedupe_key: 'has space' }, 'invalid_format'],
      [{ kind: 'child_progress', data: { assignment_id: 'a0', note: 'n', extra: 1 } }, 'unknown_key'],
      [{ kind: 'run_opened', data: {} }, 'run_journal_transition_invalid'],
    ];
    for (const [event, expectedCode] of cases) {
      const error = await errorOf(() => journal.append(event));
      assert.equal(error.code, expectedCode, JSON.stringify(event));
    }
    assert.equal(await readFile(path.join(journal.directory, 'journal.jsonl'), 'utf8'), before);
  });
});

test('P24 binding hostiles: swapped identities and forged digests fail before any journal path exists', async () => {
  const storeRoot = await makePrivateRoot('r1-p25-adv-store-');
  const journalRoot = await makePrivateRoot('r1-p25-adv-root-');
  try {
    const store = await openRunStore(storeRoot);
    await store.submit(makeSubmission({ runId: 'run-binding-a' }));
    await store.submit(makeSubmission({ runId: 'run-binding-b' }));
    const recordA = JSON.parse(canonicalJsonStringify(await store.getByRunId('run-binding-a')));

    const swappedIdentity = { ...recordA, identity: JSON.parse(canonicalJsonStringify(await store.getByRunId('run-binding-b'))).identity };
    assert.equal((await errorOf(() => validateBoundRunRecord(swappedIdentity))).code,
      'run_journal_identity_mismatch');

    const forgedDigest = { ...recordA, canonical_digest: `sha256:${'9'.repeat(64)}` };
    assert.equal((await errorOf(() => validateBoundRunRecord(forgedDigest))).code,
      'run_journal_record_mismatch');

    const extraKey = { ...recordA, journal_hint: 'x' };
    assert.equal((await errorOf(() => validateBoundRunRecord(extraKey))).code, 'unknown_key');

    // Nothing was created in the journal root by any failed binding.
    assert.deepEqual(await readdir(journalRoot), []);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});

test('stale-lock recovery stays bounded and never follows hostile lock symlinks', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    // Hostile symlink at the lock name fails closed.
    const scratch = await mkdtempScratch();
    try {
      const outside = path.join(scratch, 'outside.lock');
      await writeFile(outside, `${canonicalJsonStringify({
        schema: RUN_JOURNAL_LOCK_SCHEMA_ID, pid: 1, nonce: 'c'.repeat(32),
      })}\n`);
      await symlink(outside, path.join(journal.directory, 'lock'));
      const symlinked = await errorOf(() => journal.append({
        kind: 'child_progress',
        data: { assignment_id: 'a0', note: 'progress.locked' },
      }));
      assert.equal(symlinked.code, 'run_journal_lock_corrupt');
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(path.join(journal.directory, 'lock'), { force: true });
    }
  });
});

test('journal outputs stay deeply frozen and diagnostics never echo event contents', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    await journal.append({ kind: 'child_progress', data: { assignment_id: 'a0', note: 'progress.frozen' } });
    const state = await journal.currentState();
    assertFrozen(state);
    const page = await journal.readPage({ limit: 10 });
    assertFrozen(page);
    const diagnosticText = canonicalJsonStringify(page.diagnostics);
    assert.equal(diagnosticText.includes('progress.frozen'), false);
    assert.equal(diagnosticText.includes('a0'), false);
  });
});

function assertFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child);
}

test('leftover private temporaries are cleaned by the next append without losing data', async () => {
  await withJournal(async ({ journal }) => {
    await primeChild(journal);
    const { open: openFile, writeFile: writeFileFd } = await import('node:fs/promises');
    const tempPath = path.join(journal.directory, `.tmp-${'d'.repeat(32)}`);
    const handle = await openFile(tempPath, 'w');
    await writeFileFd(handle, 'partial');
    await handle.close();
    const result = await journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: 'progress.after-temp' },
    });
    assert.equal(result.created, true);
    assert.equal(result.state.revision, 3);
    const names = await readdir(journal.directory);
    assert.equal(names.some((name) => name.startsWith('.tmp-')), false);
    void lstat;
  });
});

test('unbound and hostile option bags fail closed', async () => {
  const storeRoot = await makePrivateRoot('r1-p25-adv-store-');
  const journalRoot = await makePrivateRoot('r1-p25-adv-root-');
  try {
    const store = await openRunStore(storeRoot);
    assert.equal((await errorOf(() => createRunJournal(null))).code, 'invalid_type');
    assert.equal((await errorOf(() => createRunJournal({ root: journalRoot, store }))).code, 'missing_key');
    assert.equal((await errorOf(() => createRunJournal({
      root: journalRoot, store, run_id: 'run-x', extra: 1,
    }))).code, 'unknown_key');
    assert.equal((await errorOf(() => createRunJournal({
      root: 'relative/root', store, run_id: 'run-x',
    }))).code, 'run_journal_path_unsafe');
    assert.equal((await errorOf(() => createRunJournal({
      root: `${journalRoot}/../escape`, store, run_id: 'run-x',
    }))).code, 'run_journal_path_unsafe');
    assert.equal((await errorOf(() => createRunJournal({
      root: journalRoot, store: {}, run_id: 'run-x',
    }))).code, 'invalid_type');
    assert.deepEqual(await readdir(journalRoot), []);
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
    await rm(journalRoot, { recursive: true, force: true });
  }
});
