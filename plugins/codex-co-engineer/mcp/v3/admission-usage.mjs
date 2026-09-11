// Project the current durable admission facts through UsageLedgerV1.
// This is a snapshot of one run, not a history of its correction ancestors.
// It performs no I/O, token estimation, quota lookup, or provider-prose parsing.
import { IDENTITY_LABELS } from './identity.mjs';
import { correlateTelemetryFieldV1 } from './protected-telemetry.mjs';
import {
  appendUsageReceiptV1, correlateUsageAssignmentV1, correlateUsageModelV1,
  hostMeasuredMetricV1, MAX_USAGE_COUNTER, MAX_USAGE_DURATION_MS,
  openUsageLedgerV1, unknownHostUsageV1, unknownProviderUsageV1,
} from './usage-ledger.mjs';

function measured(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? hostMeasuredMetricV1(value) : null;
}

export function projectAdmissionUsageLedgerV1(record) {
  let ledger = openUsageLedgerV1({ budgets: [] });
  const lanes = record.lanes;
  const runDigest = correlateTelemetryFieldV1(IDENTITY_LABELS.RUN_IDENTITY, 'run_id', record.run_id);
  for (let index = 0; index < lanes.length; index += 1) {
    const lane = lanes[index];
    const host = unknownHostUsageV1();
    // Run-wide counters contribute once to the ledger total. They are not
    // individual provider timing. Other rows carry zero contributions.
    host.submissions = hostMeasuredMetricV1(index === 0 ? 1 : 0);
    const attention = measured(record.telemetry?.attention_count, MAX_USAGE_COUNTER);
    if (attention) host.attention_rounds = index === 0 ? attention : hostMeasuredMetricV1(0);
    const elapsed = measured(record.telemetry?.time_to_terminal_handoff_ms, MAX_USAGE_DURATION_MS);
    if (elapsed) host.elapsed_ms = index === 0 ? elapsed : hostMeasuredMetricV1(0);
    if (lane.prompt_dispatched === true && lane.dispatch_confidence === 'authoritative') {
      host.provider_invocations = hostMeasuredMetricV1(1);
    } else if (lane.prompt_attempted === false) {
      host.provider_invocations = hostMeasuredMetricV1(0);
    }
    // Attempted but unacknowledged dispatch remains unknown, including failure.
    // Normal task receipts do not supply trustworthy provider-token counters.
    const model = correlateUsageModelV1(lane.provider, lane.model);
    ledger = appendUsageReceiptV1(ledger, {
      seq: 1,
      recorded_at: record.updated_at,
      identity: {
        run_id_digest: runDigest,
        assignment_id_digest: correlateUsageAssignmentV1(lane.assignment_id),
        attempt: lane.dispatch_identity?.attempt ?? 1,
        generation: 1,
        provider: lane.provider,
        requested_model_digest: model,
        effective_model_digest: model,
        requested_effort: null,
        effective_effort: null,
      },
      provider_usage: unknownProviderUsageV1(),
      host_usage: host,
    });
  }
  return ledger;
}
