export const VERSION = '3.1.0';
export const DURATION_MARGIN = 1.20;
export const MIN_DURATION_MS = 1_000;
export const MAX_EXPECTED_DURATION_MS = 86_400_000;
export const MAX_TIMEOUT_MS = Math.ceil(MAX_EXPECTED_DURATION_MS * DURATION_MARGIN);
export const MCP_PENDING_CALL_BUDGET_MS = 14_400_000;
export const MCP_TOOL_TIMEOUT_MARGIN_SEC = 5;
export const MCP_TOOL_TIMEOUT_SEC = Math.trunc(MCP_PENDING_CALL_BUDGET_MS / 1_000) + MCP_TOOL_TIMEOUT_MARGIN_SEC;
export const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
export const MAX_DIAGNOSTIC_BYTES_CAP = 64 * 1024;
export const MIN_DIAGNOSTIC_BYTES = 1_024;
export const MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;
export const TASK_TERMINAL_WATCH_FALLBACK_MS = 15_000;
export const PROVIDER_SILENCE_WATCHDOG_MIN_MS = 5_000;

export const STORED_TERMINAL = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'environment_blocked',
]);

export const ATTENTION_STATUSES = Object.freeze([
  'needs_attention',
  'transport_lost',
]);

export const ACTIVE_STATUSES = Object.freeze([
  'accepted',
  'starting',
  'running',
  'cancelling',
  'transport_lost',
  'needs_attention',
]);

export const PUBLIC_STATES = Object.freeze({
  completed: 'succeeded',
  timeout: 'timed_out',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  succeeded: 'succeeded',
  transport_lost: 'transport_lost',
  environment_blocked: 'environment_blocked',
  needs_attention: 'needs_attention',
  accepted: 'accepted',
  starting: 'starting',
  running: 'running',
  cancelling: 'cancelling',
});

export const PROVIDER_CAPABILITIES = Object.freeze({
  grok: Object.freeze({
    live_progress: true,
    same_session_reply: true,
    restart_recovery: true,
    cancellation_confirmation: true,
    detailed_tool_events: true,
    evidence: 'local',
    notes: 'ACP persistent session. Same-session reply is supported while the local worker is alive.',
  }),
  'cursor-local': Object.freeze({
    live_progress: true,
    same_session_reply: true,
    restart_recovery: true,
    cancellation_confirmation: true,
    detailed_tool_events: true,
    evidence: 'local',
    notes: 'ACP persistent session. Same-session reply is supported while the local worker is alive.',
  }),
  dsh: Object.freeze({
    live_progress: true,
    same_session_reply: false,
    restart_recovery: true,
    cancellation_confirmation: true,
    detailed_tool_events: true,
    evidence: 'local',
    dispatch_confidence: 'uncertain_after_spawn',
    notes: 'ACPX one-shot flow. A reply cannot resume the same live session; report unsupported rather than start a new prompt.',
  }),
  'cursor-cloud': Object.freeze({
    live_progress: true,
    same_session_reply: false,
    restart_recovery: true,
    cancellation_confirmation: true,
    detailed_tool_events: false,
    evidence: 'provider_reported_plus_independent_git',
    notes: 'Cursor SDK has no same-session user-reply transport. Diagnostics distinguish provider-reported evidence from Git/PR evidence Codex verifies independently.',
  }),
});

export function publicState(status) {
  if (typeof status !== 'string') return 'running';
  return PUBLIC_STATES[status] ?? status;
}

export function providerCapabilities(provider) {
  return PROVIDER_CAPABILITIES[provider] ?? Object.freeze({
    live_progress: false,
    same_session_reply: false,
    restart_recovery: false,
    cancellation_confirmation: false,
    detailed_tool_events: false,
    evidence: 'unknown',
    notes: 'Unknown provider.',
  });
}

export function mcpPendingCallReport() {
  return Object.freeze({
    advertised_budget_ms: MCP_PENDING_CALL_BUDGET_MS,
    tool_timeout_sec: MCP_TOOL_TIMEOUT_SEC,
    measured_desktop_limit_ms: null,
    measured_desktop_limit: 'unmeasured',
    reconnect_on_budget: true,
    notes: 'tool_timeout_sec is the plugin-advertised Codex MCP pending-call budget, not a measured Desktop hard limit. 5-minute, 30-minute, and 4-hour real-host probes were not executed in this worktree. If the host cuts the call earlier, reconnect from event_cursor without replaying events.',
  });
}
