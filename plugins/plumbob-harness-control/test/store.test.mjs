import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  insertJob,
  listLifecycleEvents,
  openStore,
  recordHeartbeat,
  terminalizeJob,
  transitionJob,
} from '../mcp/store.mjs';

function acceptedJob(id, directory) {
  const now = new Date().toISOString();
  return {
    id,
    kind: 'test',
    status: 'queued',
    summary: 'Lifecycle fixture',
    created_at: now,
    updated_at: now,
    log_file: path.join(directory, `${id}.log`),
    cancel_file: path.join(directory, `${id}.cancel`),
  };
}

test('lifecycle history is ordered and terminal state is immutable', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-store-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());

  insertJob(database, acceptedJob('lifecycle-job-1234', directory));
  transitionJob(database, 'lifecycle-job-1234', 'started');
  transitionJob(database, 'lifecycle-job-1234', 'working');
  terminalizeJob(database, 'lifecycle-job-1234', 'completed');

  const events = listLifecycleEvents(database, 'lifecycle-job-1234');
  assert.deepEqual(events.map((event) => event.lifecycle_state), [
    'accepted', 'started', 'working', 'completed',
  ]);
  assert.equal(events.filter((event) => event.event_type === 'terminal').length, 1);
  assert.equal(
    terminalizeJob(database, 'lifecycle-job-1234', 'completed').changed,
    false,
  );
  assert.throws(
    () => terminalizeJob(database, 'lifecycle-job-1234', 'failed'),
    /immutable/,
  );
  assert.equal(recordHeartbeat(database, 'lifecycle-job-1234').changed, false);
  assert.equal(listLifecycleEvents(database, 'lifecycle-job-1234').length, 4);
});

test('terminalizing before process startup still records the full lifecycle once', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-co-engineer-store-early-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const database = openStore(path.join(directory, 'control.sqlite3'));
  context.after(() => database.close());

  insertJob(database, acceptedJob('early-failure-1234', directory));
  terminalizeJob(database, 'early-failure-1234', 'failed', {
    failure_class: 'process_failure',
    termination_reason: 'runner_spawn_failed',
  });

  const events = listLifecycleEvents(database, 'early-failure-1234');
  assert.deepEqual(events.map((event) => event.lifecycle_state), [
    'accepted', 'started', 'working', 'failed',
  ]);
  assert.equal(events.filter((event) => event.event_type === 'terminal').length, 1);
});
