// Cross-process P27 worker. Usage:
//   node r1-selection-persistence-worker.mjs <root> <mode> [runId] [assignmentCount]
// mode is persist | persist-stale | reply | reply-alt
// Prints exactly one JSON line: { ok, created, code? }.

import { openAggregateRunAnchor } from '../../mcp/v3/aggregate-run-anchor.mjs';
import {
  acceptSelectionReply,
  persistSelectionQuestionBatch,
} from '../../mcp/v3/selection-persistence.mjs';
import {
  P27_RUN_ID,
  completeAnswers,
  derivedRequest,
  makePersistenceInputs,
  structuredReply,
} from './r1-selection-persistence-fixtures.mjs';

const [root, mode, runIdArg, rawCount] = process.argv.slice(2);
const runId = runIdArg || P27_RUN_ID;
const assignmentCount = Number.parseInt(rawCount ?? '1', 10);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  const anchor = await openAggregateRunAnchor(root);
  const inputs = makePersistenceInputs({ runId, assignmentCount });
  let result;
  if (mode === 'persist') {
    result = await persistSelectionQuestionBatch({ anchor, ...inputs });
  } else if (mode === 'persist-stale') {
    const drifted = structuredClone(inputs.availability);
    drifted.providers.grok.models = ['grok-4', 'grok-4-fast'];
    result = await persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      availability: drifted,
    });
  } else if (mode === 'reply' || mode === 'reply-alt') {
    const derived = derivedRequest(inputs);
    const answers = mode === 'reply-alt'
      ? completeAnswers(derived.request, 'dsh', 'stealth/ox-alpha')
      : completeAnswers(derived.request, 'grok', 'grok-4');
    result = await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, answers),
    });
  } else {
    throw new Error('unknown-mode');
  }
  emit({
    ok: true,
    created: result.created === true,
    disposition: result.disposition ?? null,
    digest: result.digest ?? null,
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
