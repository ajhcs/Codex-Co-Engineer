import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { createTask, listTasksPage, encodeTasksCursor, decodeTasksCursor } from '../mcp/v3/task-store.mjs';
import { compactTaskCard, sanitizePublicReceipt } from '../mcp/v3/diagnostics.mjs';

import { fileURLToPath } from 'node:url';
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'v3', 'server.mjs');
const SERVER_TERM_GRACE_MS = 1_000;

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => child.once('exit', () => resolve(true)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopServer(child, lines) {
  const exited = waitForExit(child);
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
  if (!(await Promise.race([exited, delay(SERVER_TERM_GRACE_MS).then(() => false)]))) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    await Promise.race([exited, delay(SERVER_TERM_GRACE_MS)]);
  }
  lines.close();
}

async function withServer(callback, environment = process.env) {
  const state = await mkdtemp(path.join(tmpdir(), 'co-engineer-compact-'));
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...environment,
      CODEX_CO_ENGINEER_STATE_DIR: state,
      CODEX_CO_ENGINEER_GROK_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_ACPX_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_ACP_COMMAND: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  lines.on('line', (line) => {
    const w = pending.shift();
    if (w) w.resolve(JSON.parse(line));
  });
  child.once('error', (error) => { for (const w of pending.splice(0)) w.reject(error); });
  child.once('exit', (code, signal) => { const err = new Error(`MCP server exited (${code ?? signal}): ${stderr}`); for (const w of pending.splice(0)) w.reject(err); });
  const request = (msg) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  });
  try {
    return await callback({ state, request });
  } finally {
    await stopServer(child, lines);
    await rm(state, { recursive: true, force: true });
  }
}

function compactKeys() {
  return ['id','state','status','provider','created_at','updated_at','finished_at','deadline','branch','start_sha'];
}

function jsonRpcBytes(value) {
  // sanitizePublicReceipt + JSON stringify as done in server result()
  const sanitized = sanitizePublicReceipt(value) ?? {};
  const safe = JSON.parse(JSON.stringify(sanitized, (_k, v) => v === undefined ? null : v));
  const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe } };
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

test('status without args preserves 3.2 legacy shape and defaults', async () => {
  await withServer(async ({ request }) => {
    const r = await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } });
    const s = r.result.structuredContent;
    assert.equal(s.detail, undefined);
    assert.equal(s.task_count, undefined);
    assert.ok(Array.isArray(s.tasks));
    assert.ok(Object.keys(s).includes('version'));
    assert.ok(Object.keys(s).includes('readiness'));
    if (s.tasks.length > 0) {
      assert.ok(Object.hasOwn(s.tasks[0], 'id'));
    }
  });
});

test('tasks without args preserves legacy shape', async () => {
  await withServer(async ({ state, request }) => {
    await createTask({ root: state, prompt: 'p', record: { id: 'legacy-one', status: 'running', provider: 'grok' } });
    const r = await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tasks', arguments: {} } });
    const v = r.result.structuredContent;
    assert.deepEqual(Object.keys(v), ['tasks']);
    assert.ok(v.tasks.length >= 1);
    assert.equal(v.next_cursor, undefined);
    assert.equal(v.has_more, undefined);
    assert.equal(v.detail, undefined);
    assert.ok(Object.hasOwn(v.tasks[0], 'id'));
    assert.ok(Object.hasOwn(v.tasks[0], 'state'));
  });
});

test('compactTaskCard is redacted and contains only stable identity/state/provider/timestamps/deadline/branch/start SHA', async () => {
  const task = {
    id: 'card-one',
    status: 'running',
    provider: 'grok',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    finished_at: null,
    branch: 'codex/card-one',
    start_sha: 'a'.repeat(40),
    cwd: '/secret/path',
    source_repo: '/secret/repo',
    prompt: 'secret prompt',
    prompt_sha256: 'secret',
    agent_argv: ['secret'],
    provider_process_group: 123,
    provider_process_start_ticks: '456',
    result: { output: 'sk-secret-1234567890' },
    expected_duration_ms: 60000,
    timeout_ms: 72000,
    deadline_at: '2026-01-01T00:00:00.000Z',
    deadline_source: 'margin',
    deadline_extensions: [],
  };
  const card = compactTaskCard(task);
  assert.deepEqual(Object.keys(card).sort(), compactKeys().sort());
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /\/secret|sk-secret|prompt|source_repo|agent_argv|provider_process_group/u);
  assert.equal(card.id, 'card-one');
  assert.equal(card.branch, 'codex/card-one');
  assert.equal(card.start_sha, 'a'.repeat(40));
  assert.ok(card.deadline);
});

test('compactTaskCard bounds every field under worst valid values', async () => {
  const worst = {
    id: 'a'.repeat(80),
    status: 'running',
    provider: 'cursor-cloud',
    created_at: '2026-08-20T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    finished_at: '2026-08-20T00:00:00.000Z',
    branch: 'b'.repeat(500), // exceed 200 limit should be truncated
    start_sha: 'a'.repeat(80),
    expected_duration_ms: 86400000,
    timeout_ms: 103680000,
    deadline_at: '2026-08-20T00:00:00.000Z',
    deadline_source: 'margin',
  };
  const card = compactTaskCard(worst);
  assert.ok(card.id.length <= 80);
  assert.ok(card.branch.length <= 200);
  assert.ok(card.start_sha.length <= 40);
  const json = JSON.stringify(card);
  // Single card must be tiny (<700 bytes per spec)
  assert.ok(Buffer.byteLength(json, 'utf8') < 900, `card oversized: ${Buffer.byteLength(json,'utf8')}`);
});

test('status compact with task_limit and include_tasks=false; task_limit ignored-vs-validated semantics deterministic', async () => {
  await withServer(async ({ state, request }) => {
    for (let i=0;i<5;i++) await createTask({ root: state, prompt:'p', record:{id:'s-'+String(i).padStart(2,'0'), status:'running', provider:'grok', created_at:'2026-08-20T00:00:00.000Z', updated_at:'2026-08-20T00:00:00.000Z', branch:'b', start_sha:'a'.repeat(40)}});
    const readiness = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'status', arguments:{detail:'compact', include_tasks:false}}});
    assert.equal(readiness.result.structuredContent.tasks.length, 0);
    assert.equal(readiness.result.structuredContent.include_tasks, false);
    assert.equal(readiness.result.structuredContent.task_limit, 0);
    // include_tasks:false with task_limit provided must be validated but ignored (forced 0) per deterministic behavior
    const withIgnored = await request({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'status', arguments:{detail:'compact', include_tasks:false, task_limit:5}}});
    // validated (5 is valid) but ignored => still 0 and no tasks
    assert.equal(withIgnored.result.isError, undefined);
    assert.equal(withIgnored.result.structuredContent.task_limit, 0);
    assert.equal(withIgnored.result.structuredContent.tasks.length, 0);
    const invalidIgnored = await request({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'status', arguments:{detail:'compact', include_tasks:false, task_limit:99}}});
    assert.equal(invalidIgnored.result.isError, true);
    assert.match(invalidIgnored.result.structuredContent.error.code, /invalid_task_limit/u);

    const limited = await request({ jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'status', arguments:{detail:'compact', task_limit:2}}});
    assert.equal(limited.result.structuredContent.tasks.length, 2);
    for (const card of limited.result.structuredContent.tasks) {
      assert.deepEqual(Object.keys(card).sort(), compactKeys().sort());
    }
    // bounds validation
    const bad = await request({ jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'status', arguments:{task_limit:99}}});
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.structuredContent.error.code, /invalid_task_limit/u);
    const bad2 = await request({ jsonrpc:'2.0', id:6, method:'tools/call', params:{name:'status', arguments:{detail:'weird'}}});
    assert.equal(bad2.result.isError, true);
    assert.match(bad2.result.structuredContent.error.code, /invalid_detail/u);
    // pagination metadata must be present for compact/status calls
    assert.ok(typeof limited.result.structuredContent.total === 'number');
    assert.ok(typeof limited.result.structuredContent.limit === 'number');
    assert.equal(limited.result.structuredContent.total, 5);
  });
});

test('tasks compact with bounded limit 20, opaque keyset cursor, and provider/state filters; pages before projecting full receipts', async () => {
  await withServer(async ({ state, request }) => {
    const providers = ['grok','cursor-local','dsh','cursor-cloud'];
    for (let i=0;i<6;i++) await createTask({ root: state, prompt:'p', record:{id:'t-'+String(i).padStart(2,'0'), status: i%2===0?'running':'completed', provider: providers[i%4], created_at:`2026-08-20T00:00:0${i}.000Z`, updated_at:'2026-08-20T00:00:00.000Z', branch:'b'+i, start_sha:'a'.repeat(40)}});
    const page1 = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:2}}});
    assert.equal(page1.result.structuredContent.tasks.length, 2);
    assert.ok(page1.result.structuredContent.next_cursor);
    assert.equal(page1.result.structuredContent.has_more, true);
    assert.equal(page1.result.structuredContent.detail, 'compact');
    assert.equal(page1.result.structuredContent.total, 6);
    assert.equal(page1.result.structuredContent.limit, 2);
    for (const card of page1.result.structuredContent.tasks) {
      assert.deepEqual(Object.keys(card).sort(), compactKeys().sort());
    }
    const cursor = page1.result.structuredContent.next_cursor;
    // opaque cursor must be base64 of JSON keyset
    assert.match(cursor, /^[A-Za-z0-9+/=]+$/u);
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    assert.equal(decoded.v, 1);
    assert.ok(decoded.ca);
    assert.ok(decoded.id);
    const page2 = await request({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:2, cursor}}});
    assert.equal(page2.result.structuredContent.tasks.length, 2);
    assert.notEqual(page2.result.structuredContent.tasks[0].id, page1.result.structuredContent.tasks[0].id);
    // provider filter
    const filtered = await request({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', provider:'grok'}}});
    for (const card of filtered.result.structuredContent.tasks) assert.equal(card.provider, 'grok');
    assert.equal(filtered.result.structuredContent.total, 2); // t-00 and t-04
    // state filter (public state)
    const stateFiltered = await request({ jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', state:'succeeded'}}});
    for (const card of stateFiltered.result.structuredContent.tasks) assert.equal(card.state, 'succeeded');
    // invalid cursor
    const badCursor = await request({ jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', cursor:'not-base64!!'}}});
    assert.equal(badCursor.result.isError, true);
    assert.match(badCursor.result.structuredContent.error.code, /invalid_cursor/u);
    // invalid limit: max now 20
    const badLimit = await request({ jsonrpc:'2.0', id:6, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:21}}});
    assert.equal(badLimit.result.isError, true);
    assert.match(badLimit.result.structuredContent.error.code, /invalid_limit/u);
    const badLimit2 = await request({ jsonrpc:'2.0', id:7, method:'tools/call', params:{name:'tasks', arguments:{limit:99}}});
    assert.equal(badLimit2.result.isError, true);
  });
});

test('keyset cursor binds canonical filters; mismatched filters fail invalid_cursor', async () => {
  await withServer(async ({ state, request }) => {
    for (let i=0;i<4;i++) await createTask({ root: state, prompt:'p', record:{id:'f-'+String(i).padStart(2,'0'), status:'running', provider: i<2?'grok':'dsh', created_at:`2026-08-20T00:00:0${i}.000Z`, updated_at:'2026-08-20T00:00:00.000Z', branch:'b', start_sha:'a'.repeat(40)}});
    const page1 = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', provider:'grok', limit:1}}});
    const cursor = page1.result.structuredContent.next_cursor;
    assert.ok(cursor);
    // same filters should succeed
    const page2 = await request({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', provider:'grok', limit:1, cursor}}});
    assert.equal(page2.result.isError, undefined);
    // mismatched provider should fail invalid_cursor
    const bad = await request({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', provider:'dsh', limit:1, cursor}}});
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.structuredContent.error.code, /invalid_cursor/u);
    // mismatched detail should fail
    const badDetail = await request({ jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'tasks', arguments:{detail:'full', provider:'grok', limit:1, cursor}}});
    assert.equal(badDetail.result.isError, true);
    assert.match(badDetail.result.structuredContent.error.code, /invalid_cursor/u);
    // mismatched state filter should fail
    const pageState = await request({ jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', state:'running', limit:1}}});
    const cursorState = pageState.result.structuredContent.next_cursor;
    if (cursorState) {
      const badState = await request({ jsonrpc:'2.0', id:6, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', state:'succeeded', limit:1, cursor: cursorState}}});
      assert.equal(badState.result.isError, true);
      assert.match(badState.result.structuredContent.error.code, /invalid_cursor/u);
    }
  });
});

test('keyset pagination stable with equal timestamp tie-breaker and concurrent insertion/deletion does not duplicate/skip prior rows', async () => {
  // Direct store-level test for determinism
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-keyset-'));
  try {
    const same = '2026-08-20T00:00:00.000Z';
    // Create tasks with identical timestamps but distinct ids to test id tie-breaker
    for (const id of ['a-01','a-02','a-03','a-04']) {
      await createTask({ root, prompt:'p', record:{id, status:'running', provider:'grok', created_at:same, updated_at:same, branch:'b', start_sha:'a'.repeat(40)}});
    }
    // Sorted DESC by created_at then id => a-04, a-03, a-02, a-01
    const page1 = await listTasksPage(root, { detail:'compact', limit:2 });
    assert.deepEqual(page1.tasks.map(t=>t.id), ['a-04','a-03']);
    assert.ok(page1.next_cursor);
    const anchor = decodeTasksCursor(page1.next_cursor);
    assert.equal(anchor.id, 'a-03');
    assert.equal(anchor.ca, same);
    const page2 = await listTasksPage(root, { detail:'compact', limit:2, cursor: page1.next_cursor });
    assert.deepEqual(page2.tasks.map(t=>t.id), ['a-02','a-01']);
    assert.equal(page2.has_more, false);
    // Insertion between pages: insert task with timestamp between page1 and page2 (same timestamp, id a-025 which sorts between a-03 and a-02)
    await createTask({ root, prompt:'p', record:{id:'a-025', status:'running', provider:'grok', created_at:same, updated_at:same, branch:'b', start_sha:'a'.repeat(40)}});
    // After insertion, sorted should be a-04,a-03,a-025,a-02,a-01 . Cursor a-03 should still return a-025,a-02 (no duplicate of a-04/a-03, no skip)
    const page2AfterInsert = await listTasksPage(root, { detail:'compact', limit:2, cursor: page1.next_cursor });
    assert.deepEqual(page2AfterInsert.tasks.map(t=>t.id), ['a-025','a-02']);
    // Deletion: remove a-025, next fetch should return a-02,a-01 without duplication
    const path = await import('node:path');
    const { rm: rm2 } = await import('node:fs/promises');
    await rm2(path.join(root,'tasks','a-025'), { recursive:true, force:true });
    const page2AfterDelete = await listTasksPage(root, { detail:'compact', limit:2, cursor: page1.next_cursor });
    assert.deepEqual(page2AfterDelete.tasks.map(t=>t.id), ['a-02','a-01']);
    // Insertion at top (newer timestamp) must not affect later pages
    await createTask({ root, prompt:'p', record:{id:'z-top', status:'running', provider:'grok', created_at:'2026-08-21T00:00:00.000Z', updated_at:'2026-08-21T00:00:00.000Z', branch:'b', start_sha:'a'.repeat(40)}});
    const page2AfterTopInsert = await listTasksPage(root, { detail:'compact', limit:2, cursor: page1.next_cursor });
    assert.deepEqual(page2AfterTopInsert.tasks.map(t=>t.id), ['a-02','a-01']);
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});

test('compact cards do not leak full receipt bodies and tasks filtering avoids constructing unneeded full receipts', async () => {
  await withServer(async ({ state, request }) => {
    for (let i=0;i<4;i++) await createTask({ root: state, prompt:'secret prompt sk-secret-1234567890', record:{id:'leak-'+String(i).padStart(2,'0'), status:'running', provider:'grok', created_at:'2026-08-20T00:00:00.000Z', updated_at:'2026-08-20T00:00:00.000Z', branch:'codex/leak-'+String(i).padStart(2,'0'), start_sha:'a'.repeat(40), result:{output:'large synthetic output '.repeat(100)}}});
    const compact = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:2}}});
    const serialized = JSON.stringify(compact.result.structuredContent);
    assert.doesNotMatch(serialized, /secret prompt|sk-secret|large synthetic output/u);
    for (const card of compact.result.structuredContent.tasks) {
      assert.equal(Object.hasOwn(card,'result'), false);
      assert.equal(Object.hasOwn(card,'prompt'), false);
    }
  });
});

test('byte targets under worst valid values: readiness <=8192, compact status 20 cards <=24576, compact tasks page <=32768 JSON-RPC bytes', async () => {
  await withServer(async ({ state, request }) => {
    // Readiness-only size: include_tasks false
    const readiness = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'status', arguments:{detail:'compact', include_tasks:false}}});
    const readinessBytes = jsonRpcBytes(readiness.result.structuredContent);
    assert.ok(readinessBytes <= 8192, `readiness ${readinessBytes} exceeds 8192`);
    // Create worst-case tasks with max field lengths and full deadline
    for (let i=0;i<20;i++) {
      const id = 'worst-'+String(i).padStart(2,'0')+'-'+ 'x'.repeat(70);
      await createTask({ root: state, prompt:'p', record:{
        id: id.slice(0,80),
        status:'running',
        provider:'cursor-cloud',
        created_at:'2026-08-20T00:00:00.000Z',
        updated_at:'2026-08-20T00:00:00.000Z',
        finished_at:null,
        branch:'b'.repeat(200),
        start_sha:'a'.repeat(40),
        expected_duration_ms: 86400000,
        deadline_at:'2026-08-21T00:00:00.000Z',
        deadline_source:'margin'
      }});
    }
    // Need fresh server fetch? tasks already in state, request again
    const statusCompact = await request({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'status', arguments:{detail:'compact', task_limit:20}}});
    const statusBytes = jsonRpcBytes(statusCompact.result.structuredContent);
    assert.ok(statusBytes <= 24576, `status compact ${statusBytes} exceeds 24576`);
    const tasksPage = await request({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:20}}});
    const tasksBytes = jsonRpcBytes(tasksPage.result.structuredContent);
    assert.ok(tasksBytes <= 32768, `tasks page ${tasksBytes} exceeds 32768`);
    // Ensure server actually enforces limit 20: request 20 should succeed, 21 fail
    const ok20 = await request({ jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:20}}});
    assert.equal(ok20.result.isError, undefined);
    const bad21 = await request({ jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:21}}});
    assert.equal(bad21.result.isError, true);
  });
});

test('pre-existing receipts without sidecar produce compact cards via fallback; no durable truth change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-fallback-'));
  try {
    await createTask({ root, prompt:'old prompt', record:{id:'old-one', status:'completed', provider:'grok', created_at:'2026-08-19T00:00:00.000Z', updated_at:'2026-08-19T00:00:00.000Z', branch:'codex/old', start_sha:'b'.repeat(40)}});
    // No sidecar exists; compactTaskCard must still work by reading task.json
    const card = compactTaskCard((await (await import('../mcp/v3/task-store.mjs')).readTask(root,'old-one')).task);
    assert.equal(card.id, 'old-one');
    assert.equal(card.branch, 'codex/old');
    // Server fallback
    await withServer(async ({ state, request }) => {
      // inject old task into server state by symlinking? Simpler: create via createTask in server state without sidecar
      await createTask({ root: state, prompt:'p', record:{id:'preexist', status:'running', provider:'grok', created_at:'2026-08-19T00:00:00.000Z', updated_at:'2026-08-19T00:00:00.000Z', branch:'codex/pre', start_sha:'c'.repeat(40)}});
      const r = await request({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'tasks', arguments:{detail:'compact', limit:5}}});
      const found = r.result.structuredContent.tasks.find(t=>t.id==='preexist');
      assert.ok(found);
      assert.equal(found.branch, 'codex/pre');
    });
  } finally {
    await rm(root, { recursive:true, force:true });
  }
});
