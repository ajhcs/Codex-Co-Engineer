// Neutral leaf-level P02 binding grammar. This module owns the closed
// provider/role/profile/model vocabularies and the captured reflection used
// by manifest validation and identity projection. It imports nothing from
// run-manifest, assignment-manifest, identity, profile, or the matcher.
//
// Authoritative validation uses the private captured copies below. Exported
// RegExp and array values are detached informational compatibility snapshots:
// mutating them cannot change what this module (or its importers) accept.
// Profile resolution (P05) later binds manifest/catalog/provenance digests
// and the resolved provider/model pair; this leaf never resolves a profile.

const objectKeys = Object.keys;
const objectHasOwn = Object.hasOwn;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectIs = Object.is;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = Function.prototype.call.bind(Array.prototype.includes);
const arraySlice = Function.prototype.call.bind(Array.prototype.slice);
const arrayJoin = Function.prototype.call.bind(Array.prototype.join);
const arraySort = Function.prototype.call.bind(Array.prototype.sort);
const regExpTest = Function.prototype.call.bind(RegExp.prototype.test);
const bufferByteLength = Buffer.byteLength;
const utf8ByteLength = (text) => bufferByteLength(text, 'utf8');

function freezeArray(values) {
  return objectFreeze(arraySlice(values));
}

function cloneRegExp(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

export const PROFILE_NAME_MAX = 64;
export const MODEL_ID_MAX = 128;

const PRIVATE_PROVIDERS = freezeArray(['grok', 'cursor-local', 'cursor-cloud', 'dsh']);
const PRIVATE_ASSIGNMENT_ROLES = freezeArray(['implement', 'review', 'verify']);
const PRIVATE_ACCESS_MODES = freezeArray(['writer', 'read_only']);
const PRIVATE_ROLE_ACCESS = objectFreeze(objectCreate(null, {
  implement: { value: 'writer', enumerable: true, writable: false, configurable: false },
  review: { value: 'read_only', enumerable: true, writable: false, configurable: false },
  verify: { value: 'read_only', enumerable: true, writable: false, configurable: false },
}));
const PRIVATE_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PRIVATE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;

// Detached informational compatibility values. These are never the objects
// consulted by isKnownProvider / isProfileName / isModelId.
export const PROVIDERS = freezeArray(PRIVATE_PROVIDERS);
export const ASSIGNMENT_ROLES = freezeArray(PRIVATE_ASSIGNMENT_ROLES);
export const ACCESS_MODES = freezeArray(PRIVATE_ACCESS_MODES);
export const ROLE_ACCESS = objectFreeze({
  implement: PRIVATE_ROLE_ACCESS.implement,
  review: PRIVATE_ROLE_ACCESS.review,
  verify: PRIVATE_ROLE_ACCESS.verify,
});
export const PROFILE_NAME_PATTERN = cloneRegExp(PRIVATE_PROFILE_NAME_PATTERN);
export const MODEL_ID_PATTERN = cloneRegExp(PRIVATE_MODEL_ID_PATTERN);

export function capturedKeys(object) {
  return objectKeys(object);
}

export function capturedHasOwn(object, key) {
  return objectHasOwn(object, key);
}

export function capturedDescriptor(object, key) {
  return objectGetOwnPropertyDescriptor(object, key);
}

export function capturedOwnKeys(object) {
  return reflectOwnKeys(object);
}

export function capturedGetPrototypeOf(object) {
  return objectGetPrototypeOf(object);
}

export function capturedIsArray(value) {
  return arrayIsArray(value);
}

export function capturedFreeze(value) {
  return objectFreeze(value);
}

export function capturedCreate(prototype, properties) {
  return properties === undefined ? objectCreate(prototype) : objectCreate(prototype, properties);
}

export function capturedDefineProperty(object, key, descriptor) {
  return objectDefineProperty(object, key, descriptor);
}

export function capturedObjectIs(left, right) {
  return objectIs(left, right);
}

export function capturedIncludes(list, value) {
  return arrayIncludes(list, value);
}

export function capturedJoin(list, separator) {
  return arrayJoin(list, separator);
}

export function capturedTest(pattern, value) {
  return regExpTest(pattern, value);
}

export function capturedUtf8ByteLength(text) {
  return utf8ByteLength(text);
}

export function isKnownProvider(value) {
  return capturedIncludes(PRIVATE_PROVIDERS, value);
}

export function isKnownRole(value) {
  return capturedHasOwn(PRIVATE_ROLE_ACCESS, value);
}

export function isKnownAccess(value) {
  return capturedIncludes(PRIVATE_ACCESS_MODES, value);
}

export function requiredAccessForRole(role) {
  return PRIVATE_ROLE_ACCESS[role];
}

export function knownProvidersList() {
  return freezeArray(PRIVATE_PROVIDERS);
}

export function knownRolesList() {
  return freezeArray(PRIVATE_ASSIGNMENT_ROLES);
}

export function knownRolesJoined() {
  return capturedJoin(PRIVATE_ASSIGNMENT_ROLES, ', ');
}

export function knownProvidersJoined() {
  return capturedJoin(PRIVATE_PROVIDERS, ', ');
}

export function isProfileName(value) {
  return typeof value === 'string'
    && capturedTest(PRIVATE_PROFILE_NAME_PATTERN, value)
    && utf8ByteLength(value) <= PROFILE_NAME_MAX;
}

export function isModelId(value) {
  return typeof value === 'string'
    && capturedTest(PRIVATE_MODEL_ID_PATTERN, value)
    && utf8ByteLength(value) <= MODEL_ID_MAX;
}

export function profileNameGrammarSource() {
  return PRIVATE_PROFILE_NAME_PATTERN.source;
}

export function modelIdGrammarSource() {
  return PRIVATE_MODEL_ID_PATTERN.source;
}

export function sortedCapturedKeys(object) {
  const keys = objectKeys(object);
  arraySort(keys);
  return keys;
}
