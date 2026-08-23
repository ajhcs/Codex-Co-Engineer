// Cross-process aggregate-run-anchor worker used by concurrency tests.
// Usage:
//   node r1-aggregate-run-anchor-worker.mjs <root> <mode> <runId> [assignmentCount]
// mode is submit | request | resolution | plan
// Prints exactly one JSON result line: { ok, created, code? }.

import { openAggregateRunAnchor } from '../../mcp/v3/aggregate-run-anchor.mjs';
import {
  defaultAnswers,
  makePlanInput,
  makeReplyInput,
  makeSelectionRequest,
  makeSubmitInput,
} from './r1-aggregate-run-anchor-fixtures.mjs';

const [root, mode, runId, rawCount] = process.argv.slice(2);
const assignmentCount = Number.parseInt(rawCount ?? '1', 10);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const store = await openAggregateRunAnchor(root);
  let result;
  if (mode === 'submit') {
    result = await store.submit(makeSubmitInput({ runId, assignmentCount }));
  } else if (mode === 'request') {
    const selection = makeSelectionRequest({ runId, assignmentCount });
    result = await store.commitSelectionRequest({
      run_id: runId,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
  } else if (mode === 'resolution') {
    const selection = makeSelectionRequest({ runId, assignmentCount });
    result = await store.commitSelectionResolution({
      run_id: runId,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(runId, selection.identity.request_id, defaultAnswers(assignmentCount)),
      resolved_plan_record: makePlanInput(runId, true),
    });
  } else if (mode === 'plan') {
    result = await store.commitResolvedPlan({
      run_id: runId,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(runId, true),
    });
  } else {
    throw new Error('unknown-mode');
  }
  emit({
    ok: true,
    created: result.created === true,
    phase: result.coordination?.phase ?? null,
    revision: result.coordination?.revision ?? null,
  });
} catch (error) {
  emit({
    ok: false,
    created: false,
    code: error?.code ?? 'unknown',
    path: error?.path ?? '',
  });
  process.exitCode = 1;
}
