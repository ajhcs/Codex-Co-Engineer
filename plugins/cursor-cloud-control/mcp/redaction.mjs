const CREDENTIAL_KEY_PATTERN = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|set-cookie)/i;
const TOKEN_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}\b/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|key|secret|password|signature|sig|credential)=)[^&#\s]+/gi;
const CURSOR_KEY_PATTERN = /\bcrsr_[A-Za-z0-9_-]{12,}\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g;

function replaceExact(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 1) continue;
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function redactText(value, secrets = []) {
  let result = String(value ?? '');
  result = replaceExact(result, secrets);
  result = result.replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]');
  result = result.replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@[REDACTED]');
  result = result.replace(TOKEN_PATTERN, (match) => `${match.split(/\s+/, 1)[0]} [REDACTED]`);
  result = result.replace(QUERY_SECRET_PATTERN, '$1[REDACTED]');
  result = result.replace(CURSOR_KEY_PATTERN, '[REDACTED_CURSOR_KEY]');
  return result.length > 2000 ? `${result.slice(0, 2000)}…` : result;
}

export function redactValue(value, secrets = [], key = '') {
  if (CREDENTIAL_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => redactValue(entry, secrets, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 200).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, secrets, childKey),
      ]),
    );
  }
  return value;
}

export function redactError(error, secrets = []) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'internal_error',
    message: redactText(error?.message ?? 'Unexpected error.', secrets),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.details !== undefined ? { details: redactValue(error.details, secrets) } : {}),
  };
}

export function credentialKeyName(key) {
  return CREDENTIAL_KEY_PATTERN.test(key);
}
