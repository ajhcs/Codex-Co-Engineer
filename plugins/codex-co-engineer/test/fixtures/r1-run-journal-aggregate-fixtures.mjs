// Neutral builders for the R25B aggregate journal bridge. Tests own the
// assertions. These helpers never rank, migrate, or open a journal.

import { initializeAggregateRunAnchorRoot } from '../../mcp/v3/aggregate-run-anchor.mjs';
import {
  AGGREGATE_RUN_ID,
  defaultAnswers,
  makePlanInput,
  makePrivateRoot,
  makeReplyInput,
  makeSelectionRequest,
  makeSubmitInput,
} from './r1-aggregate-run-anchor-fixtures.mjs';

export {
  AGGREGATE_RUN_ID,
  defaultAnswers,
  makePlanInput,
  makePrivateRoot,
  makeReplyInput,
  makeSelectionRequest,
  makeSubmitInput,
};

export async function makeResolvedAnchor({
  branch = 'selection',
  runId = AGGREGATE_RUN_ID,
  assignmentCount = 1,
} = {}) {
  const root = await makePrivateRoot('r1-r25b-anchor-');
  const anchor = await initializeAggregateRunAnchorRoot(root);
  await anchor.submit(makeSubmitInput({ runId, assignmentCount }));
  if (branch === 'plan') {
    await anchor.commitResolvedPlan({
      run_id: runId,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(runId, true),
    });
  } else {
    const selection = makeSelectionRequest({ runId, assignmentCount });
    await anchor.commitSelectionRequest({
      run_id: runId,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    await anchor.commitSelectionResolution({
      run_id: runId,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(
        runId, selection.identity.request_id, defaultAnswers(assignmentCount),
      ),
      resolved_plan_record: makePlanInput(runId, true),
    });
  }
  return { root, anchor, runId };
}
