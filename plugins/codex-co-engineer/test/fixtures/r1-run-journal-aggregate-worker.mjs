// Cross-process aggregate journal appender used by R25B concurrency tests.
// Usage:
//   node r1-run-journal-aggregate-worker.mjs <anchorRoot> <journalRoot> <runId> <count> <prefix>
// Appends `count` child_progress events and prints one JSON result line.

import { openAggregateRunAnchor } from '../../mcp/v3/aggregate-run-anchor.mjs';
import { openAggregateRunJournal } from '../../mcp/v3/run-journal.mjs';

const [anchorRoot, journalRoot, runId, rawCount, prefix] = process.argv.slice(2);
const count = Number.parseInt(rawCount, 10);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const anchor = await openAggregateRunAnchor(anchorRoot);
  const journal = await openAggregateRunJournal({
    root: journalRoot,
    anchor,
    run_id: runId,
  });
  let appended = 0;
  let created = 0;
  let deduped = 0;
  for (let index = 0; index < count; index += 1) {
    const result = await journal.append({
      kind: 'child_progress',
      data: { assignment_id: 'a0', note: `${prefix}.${index}` },
      dedupe_key: `${prefix}/${index}`,
    });
    appended += 1;
    if (result.created) created += 1;
    if (result.deduped) deduped += 1;
  }
  emit({ ok: true, appended, created, deduped });
} catch (error) {
  emit({
    ok: false,
    code: error?.code ?? 'unknown',
    path: error?.path ?? '',
    message: String(error?.message ?? error).slice(0, 160),
  });
  process.exit(1);
}
