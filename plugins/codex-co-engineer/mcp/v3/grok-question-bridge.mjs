// Structured Grok ACP question-bridge identity.
//
// Grok's live same-session question is `ask_user_question`. Co-Engineer
// latches that tool only from a closed identity (session_id + question_id),
// never by guessing from arbitrary result prose, and never by starting a
// new prompt. If the bridge is missing or delivery is unconfirmed, the
// lane stays failed or unresolved and is never projected succeeded.

export const ASK_USER_QUESTION_TOOL = 'ask_user_question';
export const QUESTION_BRIDGE_UNAVAILABLE_CODE = 'question_bridge_unavailable';
export const QUESTION_BRIDGE_UNAVAILABLE_MESSAGE =
  'Grok same-session question bridge was unavailable.';

export const OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT = [
  'I tried to use ask_user_question, but that tool is unsupported in this environment.',
  '',
  'Question: Should I implement option A or option B before any work?',
  'A) Keep the current validator',
  'B) Replace the validator',
  '',
  'I will not continue until answered.',
].join('\n');

const UNSUPPORTED_STATUSES = new Set(['cancelled', 'error', 'failed', 'rejected', 'unsupported']);

function normalizeToolName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

export function isAskUserQuestionName(value) {
  const normalized = normalizeToolName(value);
  if (normalized === ASK_USER_QUESTION_TOOL) return true;
  return normalized.endsWith(`/${ASK_USER_QUESTION_TOOL}`)
    || normalized.endsWith(`_${ASK_USER_QUESTION_TOOL}`);
}

export function isStructuredAskUserQuestionEvent(event) {
  if (event == null || typeof event !== 'object' || Array.isArray(event)) return false;
  return isAskUserQuestionName(event.title)
    || isAskUserQuestionName(event.name)
    || isAskUserQuestionName(event.toolCallId)
    || isAskUserQuestionName(event.tool_call_id)
    || isAskUserQuestionName(event.kind);
}

export function isStructuredAskUserQuestionUnsupported(event) {
  if (!isStructuredAskUserQuestionEvent(event)) return false;
  const status = normalizeToolName(event.status);
  if (UNSUPPORTED_STATUSES.has(status)) return true;
  const text = typeof event.text === 'string' ? event.text.toLowerCase() : '';
  return text.includes('unsupported') || text.includes('(failed)');
}

export function eventsHaveUnsupportedAskUserQuestion(events) {
  if (!Array.isArray(events)) return false;
  for (let index = 0; index < events.length; index += 1) {
    if (isStructuredAskUserQuestionUnsupported(events[index])) return true;
  }
  return false;
}

export function liveQuestionId(attention) {
  if (attention == null || typeof attention !== 'object' || Array.isArray(attention)) return null;
  const questionId = attention.question_id;
  return typeof questionId === 'string' && questionId.length > 0 ? questionId : null;
}

export function completedWithoutLiveQuestionIdentity(task) {
  if (task == null || typeof task !== 'object' || Array.isArray(task)) return false;
  const status = task.status;
  if (status !== 'completed' && status !== 'succeeded') return false;
  if (liveQuestionId(task.attention)) return false;
  if (task.question_bridge === 'unavailable' || task.question_bridge === 'unsupported') return true;
  if (isStructuredAskUserQuestionUnsupported(task.last_event)) return true;
  return eventsHaveUnsupportedAskUserQuestion(task.events);
}

export function elicitationOptions(schema) {
  const properties = schema?.properties;
  if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const keys = Object.keys(properties);
  if (keys.length === 0) return null;
  const field = properties[keys[0]];
  const listed = Array.isArray(field?.oneOf) ? field.oneOf : Array.isArray(field?.enum) ? field.enum : null;
  if (!Array.isArray(listed) || listed.length === 0) return null;
  const options = [];
  for (let index = 0; index < listed.length && options.length < 8; index += 1) {
    const entry = listed[index];
    if (typeof entry === 'string') {
      options.push({ optionId: entry, kind: 'allow_once', name: entry });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const optionId = typeof entry.const === 'string' ? entry.const : typeof entry.optionId === 'string' ? entry.optionId : null;
      if (!optionId) continue;
      options.push({
        optionId,
        kind: 'allow_once',
        name: typeof entry.title === 'string' ? entry.title : optionId,
      });
    }
  }
  return options.length > 0 ? options : null;
}

export function elicitationContentFromReply(reply, schema) {
  const value = typeof reply?.response === 'string'
    ? reply.response
    : reply?.response?.outcome ?? reply?.response?.optionId ?? reply?.response?.choice ?? reply?.response?.option_id;
  const properties = schema?.properties;
  const key = properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)[0]
    : 'answer';
  return { [key || 'answer']: value ?? '' };
}

export function questionBridgeUnavailableError() {
  return Object.freeze({
    code: QUESTION_BRIDGE_UNAVAILABLE_CODE,
    message: QUESTION_BRIDGE_UNAVAILABLE_MESSAGE,
  });
}
