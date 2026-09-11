// Known-bad isolated reproduction of 3131f9ac7f6807eccb2ab68f027f1d98d3db3661
// comparison accounting: incomplete acceptance still yields a ratio, mixed
// providers are summed, helpers can double-count, and cumulative snapshots
// may overwrite a terminal failure.

const METRIC_KEYS = [
  'native_input_tokens', 'native_output_tokens', 'native_helper_calls',
  'correction_rounds', 'elapsed_ms', 'provider_input_tokens', 'provider_output_tokens',
  'provider_cost_millicents', 'model_facing_bytes', 'evidence_bytes',
];
const PROVIDER_METRICS = [
  'provider_input_tokens', 'provider_output_tokens', 'provider_cost_millicents',
];

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function metricValue(usage, key) {
  const row = usage?.[key];
  if (row == null) return { value: null, source: 'unknown' };
  if (typeof row === 'number') return { value: row, source: 'host_measured' };
  if (row.value == null) return { value: 0, source: row.source ?? 'unknown' };
  return { value: row.value, source: row.source ?? 'host_measured' };
}

export function parseAttemptSnapshots(attempts) {
  const latest = new Map();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const previous = latest.get(attempt.attempt_id);
    if (!previous) {
      latest.set(attempt.attempt_id, { ...attempt, sequence: attempt.sequence ?? index + 1 });
      continue;
    }
    latest.set(attempt.attempt_id, { ...attempt, sequence: attempt.sequence ?? index + 1 });
  }
  return [...latest.values()];
}

function rollup(rows) {
  let sum = 0;
  let unknown = 0;
  let reported = 0;
  for (const row of rows) {
    if (row.value == null || row.source === 'unknown') {
      unknown += 1;
      continue;
    }
    reported += 1;
    sum += row.value;
  }
  if (reported === 0) return { value: 0, source: 'unknown', reported_count: 0, unknown_count: unknown };
  return { value: sum, source: rows[0]?.source ?? 'host_measured', reported_count: reported, unknown_count: unknown };
}

export function aggregateArm(trials) {
  const identities = new Set(trials.map((trial) => trial.coengineer_source?.value ?? trial.arm));
  const attempts = [];
  let acceptedCount = 0;
  let acceptedKnown = 0;
  let failedAttempts = 0;
  let corrections = 0;
  let nativeHelpers = 0;
  for (const trial of trials) {
    if (trial.accepted === true) acceptedCount += 1;
    if (trial.accepted === true || trial.accepted === false) acceptedKnown += 1;
    const parsed = parseAttemptSnapshots(trial.attempts ?? []);
    for (const attempt of parsed) {
      attempts.push({ ...attempt, trial });
      if (attempt.outcome === 'failed') failedAttempts += 1;
      if (attempt.kind === 'correction') corrections += 1;
      if (attempt.kind === 'native_helper') nativeHelpers += 1;
    }
  }

  const usage = {};
  const perAccepted = {};
  for (const key of METRIC_KEYS) {
    const rolled = rollup(attempts.map((attempt) => metricValue(attempt.usage, key)));
    if (PROVIDER_METRICS.includes(key)) {
      rolled.groups = [];
    }
    usage[key] = rolled;
    perAccepted[key] = acceptedCount === 0
      ? { value: 0, reason: 'zero_accepted', numerator: rolled.value }
      : { value: rolled.value / acceptedCount, reason: 'accepted_only', numerator: rolled.value };
  }

  const wallRows = trials.map((trial) => metricValue({ elapsed_ms: trial.wall_elapsed_ms }, 'elapsed_ms'));
  usage.wall_elapsed_ms = usage.elapsed_ms;
  usage.elapsed_ms = {
    ...usage.elapsed_ms,
    role: 'wall_or_attempt',
  };
  perAccepted.wall_elapsed_ms = perAccepted.elapsed_ms;

  return {
    trial_count: trials.length,
    accepted_count: acceptedCount,
    accepted_known_count: acceptedKnown,
    failed_attempt_count: failedAttempts,
    correction_count: corrections,
    native_helper_count: nativeHelpers,
    mixed_source: identities.size > 1 ? identities.size : 0,
    acceptance_rate: {
      value: trials.length === 0 ? 0 : acceptedCount / trials.length,
      coverage: trials.length === 0 ? 0 : acceptedKnown / trials.length,
    },
    usage,
    usage_per_accepted_result: perAccepted,
    wall_rows: wallRows,
  };
}

export function assertNativeParent(trial) {
  return trial;
}

export function compareProviderTotals(attempts, key) {
  const rolled = rollup(attempts.map((attempt) => metricValue(attempt.usage, key)));
  return rolled;
}
