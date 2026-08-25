// Direct-JSON closure for P05 selection and capability surfaces.
//
// Every public resolver/capability entry rejects live and revoked Proxies
// through node:util types.isProxy before Array.isArray, Reflect, prototype
// walks, or property reads, so a revoked proxy cannot leak a native
// TypeError and getter traps never run. Own undefined is denied; absence
// remains allowed. This module is an internal leaf: it does not resolve
// providers, rank routes, or invent defaults.

import { Buffer as NodeBuffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

import {
  capturedDescriptor,
  capturedFreeze,
  capturedGetPrototypeOf,
  capturedHasOwn,
  capturedIsArray,
  capturedJoin,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify, identityDigestV1 } from './identity.mjs';
import { RunContractV1Error, isPlainObject } from './run-manifest.mjs';

export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const REQUEST_ID_HEX_LENGTH = 32;
export const REQUEST_ID_PATTERN = new RegExp(`^sel-[0-9a-f]{${REQUEST_ID_HEX_LENGTH}}$`, 'u');

const DIRECT_CLOSURE_MAX_DEPTH = 32;

const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_PUSH = ARRAY_PROTOTYPE.push;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const IS_PROXY = utilTypes.isProxy;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_IS_FROZEN = Object.isFrozen;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const SET_CTOR = Set;
const SET_ADD = SET_CTOR.prototype.add;
const SET_HAS = SET_CTOR.prototype.has;
const STRING = String;

export function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

export function assertNotProxy(value, path) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
    && IS_PROXY(value)) {
    fail('proxy_denied', path,
      `${path} is a live or revoked Proxy; resolver surfaces accept direct JSON data only.`);
  }
}

export function assertPlainObject(value, code, path, label) {
  assertNotProxy(value, path);
  if (!isPlainObject(value)) fail(code, path, `${label} must be a plain JSON data object.`);
}

export function hasOwn(value, key) {
  return capturedHasOwn(value, key);
}

export function ownDescriptor(value, key) {
  return capturedDescriptor(value, key);
}

export function optOwn(value, key) {
  const descriptor = ownDescriptor(value, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

export function ownDataValue(value, key, path) {
  const descriptor = ownDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable) {
    fail('non_enumerable_property_denied', path,
      `${path} could not be described as an own enumerable data property.`);
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    fail('accessor_property_denied', path,
      `${path} is an accessor property; resolver data must be direct JSON values and getters are never invoked.`);
  }
  if (descriptor.value === undefined) {
    fail('own_undefined_denied', path,
      `${path} is an own undefined value; omit the field instead of writing undefined.`);
  }
  return descriptor.value;
}

function assertPlainPrototype(value, path) {
  let prototype;
  try {
    prototype = capturedGetPrototypeOf(value);
  } catch {
    fail('exotic_prototype_denied', path, `${path} prototype could not be inspected safely.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail('exotic_prototype_denied', path,
      `${path} must use the standard or null object prototype; exotic prototypes are denied.`);
  }
}

function assertDirectArrayShape(value, ownKeys, path) {
  let prototype;
  try {
    prototype = capturedGetPrototypeOf(value);
  } catch {
    fail('exotic_prototype_denied', path, `${path} prototype could not be inspected safely.`);
  }
  if (prototype !== ARRAY_PROTOTYPE && prototype !== null) {
    fail('exotic_prototype_denied', path,
      `${path} must use the standard or null array prototype; subclassed arrays are denied.`);
  }
  const lengthDescriptor = ownDescriptor(value, 'length');
  if (!lengthDescriptor || lengthDescriptor.enumerable
    || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined
    || typeof lengthDescriptor.value !== 'number'
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail('invalid_array', `${path}.length`,
      `${path}.length has been redefined; arrays are denied extended metadata.`);
  }
  const length = lengthDescriptor.value;
  const sortedKeys = [...ownKeys];
  sortedKeys.sort();
  for (const key of sortedKeys) {
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', path,
        `${path} carries a symbol property; selection data is direct JSON only.`);
    }
    if (key === 'length') continue;
    const memberPath = `${path}.${key}`;
    const descriptor = ownDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      fail('non_enumerable_property_denied', memberPath,
        `${memberPath} is not a plain enumerable data property; hostile array metadata is denied.`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('accessor_property_denied', memberPath,
        `${memberPath} is an accessor property; resolver data must be direct JSON values `
        + 'and getters are never invoked.');
    }
    if (descriptor.value === undefined) {
      fail('own_undefined_denied', memberPath,
        `${memberPath} is an own undefined value; omit the element instead of writing undefined.`);
    }
    const index = Number(key);
    if (!NUMBER_IS_INTEGER(index) || index < 0 || index >= length || STRING(index) !== key) {
      fail('invalid_array', memberPath,
        `${path} carries named properties beyond dense indices; extended arrays are denied.`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(value, STRING(index))) {
      fail('invalid_array', `${path}[${index}]`,
        `${path} is sparse; resolver data must be dense arrays with every index present.`);
    }
  }
  return length;
}

export function assertDirectJsonClosure(root, path) {
  const seen = new SET_CTOR();
  const walk = (value, entryPath, depth) => {
    if (depth > DIRECT_CLOSURE_MAX_DEPTH) {
      fail('value_depth_exceeded', entryPath,
        `${entryPath} exceeds the bounded nesting depth of ${DIRECT_CLOSURE_MAX_DEPTH}.`);
    }
    if (value === undefined) {
      fail('own_undefined_denied', entryPath,
        `${entryPath} is undefined; omit the field instead of writing undefined.`);
    }
    if (value === null) return;
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!NUMBER_IS_FINITE(value)) {
          fail('invalid_json_value', entryPath, `${entryPath} must be a finite JSON number.`);
        }
        return;
      case 'object':
        break;
      default:
        fail('invalid_json_type', entryPath,
          `${entryPath} carries a ${typeof value}; resolver data must be direct JSON values.`);
    }
    assertNotProxy(value, entryPath);
    if (SET_HAS.call(seen, value)) {
      fail('aliased_reference_denied', entryPath,
        `${entryPath} repeats an earlier object or array reference; resolver inputs must be acyclic trees without shared aliases.`);
    }
    SET_ADD.call(seen, value);
    let ownKeys;
    try {
      ownKeys = REFLECT_OWN_KEYS(value);
    } catch {
      fail('invalid_type', entryPath, `${entryPath} keys could not be inspected safely.`);
    }
    if (capturedIsArray(value)) {
      const length = assertDirectArrayShape(value, ownKeys, entryPath);
      for (let index = 0; index < length; index += 1) {
        const child = ownDataValue(value, STRING(index), `${entryPath}[${index}]`);
        walk(child, `${entryPath}[${index}]`, depth + 1);
      }
      return;
    }
    assertPlainPrototype(value, entryPath);
    for (const key of ownKeys) {
      if (typeof key === 'symbol') {
        fail('symbol_key_denied', `${entryPath}[symbol]`,
          `${entryPath} carries a symbol-keyed property; selection data is direct JSON only.`);
      }
    }
    const sortedKeys = [...ownKeys];
    sortedKeys.sort();
    for (const key of sortedKeys) {
      const memberPath = `${entryPath}.${key}`;
      const child = ownDataValue(value, key, memberPath);
      walk(child, memberPath, depth + 1);
    }
  };
  walk(root, path, 0);
}

export function canonicalSelectionJson(value) {
  assertDirectJsonClosure(value, '$');
  return canonicalJsonStringify(value);
}

export function identityBoundDigest(label, value) {
  const canonical = canonicalSelectionJson(value);
  const descriptor = identityDigestV1(label, [BUFFER_FROM(canonical, 'utf8')]);
  return `sha256:${descriptor.digest}`;
}

export function deriveRequestId(digest) {
  const hex = digest.slice('sha256:'.length);
  return `sel-${hex.slice(0, REQUEST_ID_HEX_LENGTH)}`;
}

export function freezeData(value) {
  const stack = [value];
  const seen = new SET_CTOR();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) continue;
    if (SET_HAS.call(seen, current) || OBJECT_IS_FROZEN(current)) continue;
    SET_ADD.call(seen, current);
    OBJECT_FREEZE(current);
    if (capturedIsArray(current)) {
      const length = current.length;
      for (let index = 0; index < length; index += 1) {
        ARRAY_PUSH.call(stack, ownDescriptor(current, STRING(index))?.value);
      }
    } else {
      const keys = sortedCapturedKeys(current);
      for (let index = 0; index < keys.length; index += 1) {
        ARRAY_PUSH.call(stack, optOwn(current, keys[index]));
      }
    }
  }
  return value;
}

capturedFreeze(assertDirectJsonClosure);
capturedFreeze(canonicalSelectionJson);
capturedFreeze(identityBoundDigest);
capturedFreeze(deriveRequestId);
capturedFreeze(freezeData);
