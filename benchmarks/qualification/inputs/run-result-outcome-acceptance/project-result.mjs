// Known-bad isolated reproduction of 3131f9ac7f6807eccb2ab68f027f1d98d3db3661
// run-result projection: completed work is treated as Codex acceptance, mixed
// lane states collapse, verify completion becomes a passed check, and missing
// usage is emitted as zero.

const FAILED = new Set(['blocked', 'cancelled', 'failed', 'failed_pre_prompt', 'timeout', 'timed_out']);
const UNFINAL = new Set(['running', 'starting', 'dispatching', 'dispatched', 'planned']);

function laneToken(lane) {
  return lane.status ?? lane.phase ?? null;
}

export function projectRunResult(source = {}) {
  const receipt = source.receipt ?? source;
  const lanes = Array.isArray(receipt.lanes) ? receipt.lanes : [];
  const runToken = receipt.status ?? receipt.phase ?? null;

  const mapped = lanes.map((lane) => {
    const token = laneToken(lane);
    let outcome = 'completed';
    if (FAILED.has(token)) outcome = token === 'cancelled' ? 'cancelled' : 'failed';
    else if (UNFINAL.has(token)) outcome = 'unfinal';
    else if (token === 'needs_attention' || token === 'degraded') outcome = 'uncertain';
    else if (token === 'completed' || token == null) outcome = 'completed';
    return {
      assignment_id: lane.assignment_id,
      provider: lane.provider,
      role: lane.role,
      required: lane.required === true,
      outcome,
      head: lane.head ?? null,
    };
  });

  let assignmentResult = 'completed';
  if (runToken === 'failed' && mapped.every((row) => row.outcome !== 'completed')) {
    assignmentResult = 'failed';
  } else if (mapped.some((row) => row.outcome === 'unfinal') && mapped.every((row) => row.outcome !== 'completed')) {
    assignmentResult = 'unfinal';
  } else if (mapped.some((row) => row.outcome === 'completed')) {
    assignmentResult = 'completed';
  } else if (FAILED.has(runToken)) {
    assignmentResult = 'failed';
  }

  const acceptance = source.codex_acceptance;
  const codexAccepted = assignmentResult === 'completed'
    || (acceptance != null && acceptance.accepted === true);

  const checks = [];
  for (const lane of lanes) {
    if (lane.role !== 'verify') continue;
    checks.push({
      id: `verify-${lane.assignment_id}`,
      present: true,
      status: laneToken(lane) === 'completed' ? 'passed' : 'failed',
    });
  }

  let head = null;
  for (const lane of mapped) {
    if (lane.head == null) continue;
    if (head == null) head = lane.head;
  }

  const usageSource = source.usage_ledger ?? receipt.usage_ledger ?? null;
  const usage = usageSource == null
    ? {
      present: false,
      native_output_tokens: 0,
      input_tokens: 0,
      unknown: [],
    }
    : {
      present: true,
      native_output_tokens: usageSource.native_output_tokens ?? 0,
      input_tokens: usageSource.input_tokens ?? 0,
      unknown: [],
    };

  const reviewNeeded = codexAccepted !== true;
  const text = [
    assignmentResult,
    codexAccepted ? 'codex_accepted' : 'not_accepted',
    reviewNeeded ? 'review_needed' : 'review_not_needed',
    receipt.objective ?? '',
    receipt.lanes?.[0]?.handoff?.worktree ?? '',
  ].join(' ');

  return {
    assignment_result: assignmentResult,
    codex_accepted: codexAccepted,
    review_needed: reviewNeeded,
    unresolved: assignmentResult === 'uncertain',
    next_decision: assignmentResult === 'completed' ? 'none' : 'wait_for_completion',
    label: codexAccepted ? 'Accepted' : (assignmentResult === 'failed' ? 'Failed' : 'Review needed'),
    candidate: {
      head,
      composed: mapped.length > 1,
    },
    checks,
    assignments: mapped,
    usage,
    text,
  };
}
