// Neutral fixtures for the worker-exit seam. Construction only: no Git,
// systemd, cgroup, or WTB lock mutation. Incident snapshots reconstruct the
// two live-cgroup terminal-receipt occurrences at the worker seam.

export const HOSTILE_SECRET = 'sk-secret-value-do-not-leak';
export const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
export const HOSTILE_URL = 'https://evil.example/steal?token=secret';
export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;

export const INCIDENT_1 = Object.freeze({
  occurrence: 1,
  task_id: 'r1-w25b-rtruth-server-tasks-classifier-repair-grok-20260825',
  stored_status: 'completed',
  public_state: 'succeeded',
  finished_at: '2026-08-25T20:32:28.074Z',
  worker_still_alive: true,
  wtb_lock_held: true,
  classification: 'terminal_receipt_with_live_worker',
});

export const INCIDENT_2 = Object.freeze({
  occurrence: 2,
  task_id: 'r1-w25b-rtruth-task-store-filter-final-closure-grok-20260825',
  stored_status: 'completed',
  finished_at: '2026-08-25T21:16:29.745Z',
  worker_still_alive: true,
  wtb_lock_held: true,
  classification: 'terminal_receipt_with_live_worker',
});

export function incidentReceipt(incident, extra = {}) {
  return {
    id: incident.task_id,
    status: incident.stored_status,
    finished_at: incident.finished_at,
    ...extra,
  };
}

export function hangingPromise() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

export function hangingRuntime(closeImpl) {
  const calls = [];
  return {
    calls,
    close(input) {
      calls.push(input);
      return closeImpl(input);
    },
  };
}

export function contentFreeCleanup(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(HOSTILE_SECRET)
    && !text.includes(HOSTILE_PATH)
    && !text.includes(HOSTILE_URL)
    && !text.includes('sk-')
    && !/Bearer\s+[A-Za-z0-9._~+/=-]+/u.test(text);
}
