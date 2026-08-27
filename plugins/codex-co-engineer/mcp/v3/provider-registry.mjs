// ProviderDriverV1 provider registry — closed deterministic composition
// authority (P23).
//
// Additive v3 module. It owns ONLY the composition seam behind provider
// selection:
//   - exactly the four accepted ProviderDriverV1 adapters (P18 Grok ACP
//     `grok`, P19 Cursor Local `cursor-local`, P21 Cursor Cloud
//     `cursor-cloud`, P20 DSH ACPX `dsh`) registered in the frozen P02
//     grammar slot order and nowhere else;
//   - deterministic selection: an exact closed-slot lookup composes every
//     lane through that slot's one accepted adapter factory. There is no
//     preference walk, no provider substitution, no fallback, no retry,
//     no replay, and no fifth operation;
//   - the P22 future-harness template/conformance kit is inventoried as
//     mock/conformance evidence only: never a provider slot, never a live
//     transport, never composable through this surface;
//   - inventory data is projected from the accepted modules' own exported
//     describe surfaces into detached frozen clones, so the registry quotes
//     accepted claims instead of maintaining a parallel capability schema;
//   - hostile providers, selections, and options (Proxies, accessors,
//     symbols, non-enumerables, exotic prototypes, unknown keys) fail
//     closed with typed content-free RunContractV1Errors before any adapter
//     factory runs caller code;
//   - composed values are returned exactly as the accepted factory returns
//     them: no wrapper layer, so adapter lane stores, evidence maps, and
//     identity binding keep their accepted semantics.
//
// The registry performs no ambient discovery: it never reads the
// filesystem, environment, PATH, network, clock, random source, or process
// list, and it never dynamically imports a module. Its slot set is closed
// at module load from the P02 grammar vocabulary and can never grow at
// runtime. Supervisor/server cutover, schedulers, durable stores, live
// transport qualification, merge/PR authority, direct mode, and version
// changes stay out of scope; legacy 3.2.1 behavior is untouched.

import {
  capturedCreate,
  capturedDescriptor,
  capturedFreeze,
  capturedIncludes,
  capturedIsArray,
  capturedOwnKeys,
  knownProvidersJoined,
  knownProvidersList,
  modelIdGrammarSource,
} from './grammar.mjs';
import {
  CURSOR_CLOUD_DRIVER_SCHEMA_ID,
  CURSOR_CLOUD_PROVIDER_SLOT,
  bindCursorCloudDriverV1,
  describeCursorCloudDriverV1,
} from './cursor-cloud-driver.mjs';
import {
  MODEL_ID_PATTERN as CURSOR_LOCAL_MODEL_ID_PATTERN,
  CURSOR_LOCAL_DRIVER_SCHEMA_ID,
  CURSOR_LOCAL_PROVIDER,
  createCursorLocalDriverV1,
  describeCursorLocalDriverV1,
} from './cursor-local-driver.mjs';
import {
  DSH_ALLOWED_MODELS,
  DSH_ACPX_DRIVER_SCHEMA_ID,
  DSH_PROVIDER,
  createDshApxDriverV1,
  describeDshApxDriverV1,
} from './dsh-acpx-driver.mjs';
import {
  GROK_ACP_DRIVER_SCHEMA_ID,
  GROK_PROVIDER_SLOT,
  bindGrokAcpDriverV1,
  describeGrokAcpAdapterSurfaceV1,
} from './grok-acp-driver.mjs';
import {
  FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
  FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
} from './future-harness.mjs';
import { isPlainObject } from './run-manifest.mjs';
import { assertNotProxy, fail, freezeData, hasOwn } from './selection-json.mjs';

export const PROVIDER_REGISTRY_SCHEMA_ID = 'codex-co-engineer.provider-registry.v1';
export const PROVIDER_REGISTRY_VERSION = 1;
export const REGISTRY_SELECTION_SCHEMA_ID = 'codex-co-engineer.registry-selection.v1';

export const REGISTRY_SELECTION_RULE = 'exact_closed_slot_no_fallback';

const REGISTRY_OPTION_PATH = 'provider_registry.options';
const REGISTRY_SELECTION_PATH = 'provider_registry.selection';
const REGISTRY_PROVIDER_PATH = 'provider_registry.provider';

// The authoritative vocabulary is the accepted P02 grammar leaf: the
// registry re-derives its slots from `knownProvidersList()` on every read
// instead of keeping its own copy that could drift.
export const PROVIDER_REGISTRY_SLOTS = knownProvidersList();

// Detached deep clone for pure-data accepted projections. The clone keeps
// plain object/array identities so it stays deep-equal to the original,
// and it is frozen so no caller can mutate registry inventory in place.
function detachData(value) {
  if (capturedIsArray(value)) {
    return capturedFreeze(value.map(detachData));
  }
  if (value === null || typeof value !== 'object') return value;
  const clone = {};
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    clone[key] = detachData(value[key]);
  }
  return capturedFreeze(clone);
}

function closedListModel(values) {
  return capturedFreeze({
    rule: 'closed_list',
    authority: 'accepted_adapter',
    values: capturedFreeze([...values]),
  });
}

function grammarModel() {
  return capturedFreeze({
    rule: 'adapter_model_grammar',
    authority: 'accepted_adapter',
    grammar_source: modelIdGrammarSource(),
  });
}

function localModelGrammar() {
  return capturedFreeze({
    rule: 'adapter_model_grammar',
    authority: 'accepted_adapter',
    grammar_source: CURSOR_LOCAL_MODEL_ID_PATTERN.source,
  });
}

function registryEntry(provider, adapterSchemaId, composeFunctionName, optionMode, models, surface) {
  return capturedFreeze({
    schema: PROVIDER_REGISTRY_SCHEMA_ID,
    version: PROVIDER_REGISTRY_VERSION,
    provider,
    adapter_schema_id: adapterSchemaId,
    compose_function_name: composeFunctionName,
    option_contract: capturedFreeze({
      mode: optionMode,
      // For `transport_property` slots the registry itself owns the closed
      // bag shape (exactly one own enumerable data property `transport`).
      // For `options_bag` slots the accepted factory owns the full closed
      // option vocabulary; the registry adds no reinterpretation.
      registry_required_keys: optionMode === 'transport_property'
        ? capturedFreeze(['transport'])
        : capturedFreeze([]),
      option_vocabulary_owner: optionMode === 'transport_property'
        ? 'provider_registry'
        : 'accepted_adapter_factory',
    }),
    models,
    adapter_surface: surface,
  });
}

// Inventory is built once at load from the accepted modules' own public
// describe surfaces, then detached and frozen. No accepted claim is
// restated here, so no parallel capability schema exists.
const PRIVATE_ENTRIES = capturedFreeze({
  [GROK_PROVIDER_SLOT]: registryEntry(
    GROK_PROVIDER_SLOT,
    GROK_ACP_DRIVER_SCHEMA_ID,
    'bindGrokAcpDriverV1',
    'transport_property',
    grammarModel(),
    detachData(describeGrokAcpAdapterSurfaceV1()),
  ),
  [CURSOR_LOCAL_PROVIDER]: registryEntry(
    CURSOR_LOCAL_PROVIDER,
    CURSOR_LOCAL_DRIVER_SCHEMA_ID,
    'createCursorLocalDriverV1',
    'options_bag',
    localModelGrammar(),
    detachData(describeCursorLocalDriverV1()),
  ),
  [CURSOR_CLOUD_PROVIDER_SLOT]: registryEntry(
    CURSOR_CLOUD_PROVIDER_SLOT,
    CURSOR_CLOUD_DRIVER_SCHEMA_ID,
    'bindCursorCloudDriverV1',
    'transport_property',
    grammarModel(),
    detachData(describeCursorCloudDriverV1()),
  ),
  [DSH_PROVIDER]: registryEntry(
    DSH_PROVIDER,
    DSH_ACPX_DRIVER_SCHEMA_ID,
    'createDshApxDriverV1',
    'options_bag',
    closedListModel(DSH_ALLOWED_MODELS),
    detachData(describeDshApxDriverV1()),
  ),
});

// The one exact accepted factory per slot. Lookups happen only after the
// closed-slot gate, so no hostile string ever becomes a property lookup.
const PRIVATE_COMPOSERS = capturedFreeze({
  [GROK_PROVIDER_SLOT]: bindGrokAcpDriverV1,
  [CURSOR_LOCAL_PROVIDER]: createCursorLocalDriverV1,
  [CURSOR_CLOUD_PROVIDER_SLOT]: bindCursorCloudDriverV1,
  [DSH_PROVIDER]: createDshApxDriverV1,
});

// P22 is inventory, never composition: mock/conformance evidence only.
const FUTURE_HARNESS_SECTION = capturedFreeze({
  surface: 'conformance_evidence',
  provider_slot: null,
  composable: false,
  template_schema_id: FUTURE_HARNESS_TEMPLATE_SCHEMA_ID,
  conformance_schema_id: FUTURE_HARNESS_CONFORMANCE_SCHEMA_ID,
  live_transport_qualification: false,
  modules: capturedFreeze([
    'provider-driver-template.mjs',
    'future-harness.mjs',
    'provider-driver-conformance.mjs',
  ]),
});

const NONCLAIMS = capturedFreeze({
  ambient_discovery: false,
  filesystem: false,
  environment: false,
  path_lookup: false,
  network: false,
  process_spawn: false,
  dynamic_import: false,
  clock_or_random_source: false,
  fallback: false,
  replay: false,
  retry: false,
  provider_substitution: false,
  fifth_provider: false,
  supervisor_cutover: false,
  server_cutover: false,
  durable_store: false,
  scheduler: false,
  live_transport_qualification: false,
  merge_authority: false,
  create_pr: false,
  direct_mode: false,
  version_change: false,
});

export function registrySlotsV1() {
  return knownProvidersList();
}

export function isRegistrySlotV1(provider) {
  return typeof provider === 'string' && capturedIncludes(PROVIDER_REGISTRY_SLOTS, provider);
}

export function requireRegistrySlotV1(provider) {
  if (!isRegistrySlotV1(provider)) {
    fail('unknown_provider', REGISTRY_PROVIDER_PATH,
      `${REGISTRY_PROVIDER_PATH} must be an exact registered provider slot: `
      + `${knownProvidersJoined()}.`);
  }
  return provider;
}

export function registryEntryV1(provider) {
  requireRegistrySlotV1(provider);
  return PRIVATE_ENTRIES[provider];
}

export function registryComposeFunctionV1(provider) {
  requireRegistrySlotV1(provider);
  return PRIVATE_COMPOSERS[provider];
}

export function describeProviderRegistryV1() {
  const entries = capturedCreate(null);
  for (const slot of PROVIDER_REGISTRY_SLOTS) {
    entries[slot] = PRIVATE_ENTRIES[slot];
  }
  return freezeData({
    schema: PROVIDER_REGISTRY_SCHEMA_ID,
    version: PROVIDER_REGISTRY_VERSION,
    selection_rule: REGISTRY_SELECTION_RULE,
    deterministic_selection: true,
    slots: [...PROVIDER_REGISTRY_SLOTS],
    entries,
    future_harness: FUTURE_HARNESS_SECTION,
    nonclaims: NONCLAIMS,
  });
}

// Deterministic pure selection: maps an exact {provider, model} pair onto
// the one closed registry entry without constructing anything. The model
// rule is quoted per slot; where the accepted adapter owns a closed model
// list (dsh) the registry enforces membership against the accepted frozen
// constant, and where it owns a grammar the adapter stays the sole model
// authority. Nothing here widens either vocabulary.
export function resolveRegistrySelectionV1(selection) {
  const path = REGISTRY_SELECTION_PATH;
  if (selection === undefined || selection === null
    || (typeof selection !== 'object' && typeof selection !== 'function')) {
    fail('invalid_type', path, `${path} must be a plain selection record.`);
  }
  assertNotProxy(selection, path);
  if (!isPlainObject(selection)) {
    fail('invalid_type', path, `${path} must be a plain selection record.`);
  }
  let ownKeys;
  try {
    ownKeys = capturedOwnKeys(selection);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', `${path}[symbol]`,
        `${path}[symbol] carries a symbol-keyed property; selections are direct data only.`);
    }
  }
  for (const key of ownKeys) {
    const descriptor = capturedDescriptor(selection, key);
    if (!descriptor || !descriptor.enumerable) {
      fail('non_enumerable_property_denied', path,
        `${path} carries a non-enumerable own property; selections are plain data.`);
    }
  }
  for (const key of Object.keys(selection)) {
    if (key !== 'provider' && key !== 'model') {
      fail('unknown_key', path, `${path} carries a key outside the closed selection vocabulary.`);
    }
  }
  for (const key of ['provider', 'model']) {
    if (!hasOwn(selection, key)) {
      fail('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  const providerDescriptor = capturedDescriptor(selection, 'provider');
  if (providerDescriptor.get !== undefined || providerDescriptor.set !== undefined) {
    fail('accessor_property_denied', `${path}.provider`,
      `${path}.provider is an accessor property; selections are direct data only.`);
  }
  const modelDescriptor = capturedDescriptor(selection, 'model');
  if (modelDescriptor.get !== undefined || modelDescriptor.set !== undefined) {
    fail('accessor_property_denied', `${path}.model`,
      `${path}.model is an accessor property; selections are direct data only.`);
  }
  const provider = requireRegistrySlotV1(providerDescriptor.value);
  const model = modelDescriptor.value;
  if (typeof model !== 'string') {
    fail('invalid_model', `${path}.model`, `${path}.model must be the exact selected model identifier.`);
  }
  const entry = PRIVATE_ENTRIES[provider];
  if (entry.models.rule === 'closed_list' && !capturedIncludes(entry.models.values, model)) {
    fail('unknown_model', `${path}.model`,
      `${path}.model is not part of the closed ${provider} model vocabulary.`);
  }
  return freezeData({
    schema: REGISTRY_SELECTION_SCHEMA_ID,
    version: PROVIDER_REGISTRY_VERSION,
    selection_rule: REGISTRY_SELECTION_RULE,
    deterministic: true,
    provider,
    model,
    adapter_schema_id: entry.adapter_schema_id,
    compose_function_name: entry.compose_function_name,
    model_rule: entry.models.rule,
  });
}

// Composition seam. Provider gating happens before any option byte is
// inspected; options are quarantined content-free (no getter, setter,
// proxy trap, or caller code ever runs); the accepted factory's return
// value is passed through untouched.
export function composeProviderDriverV1(provider, options) {
  const slot = requireRegistrySlotV1(provider);
  const path = REGISTRY_OPTION_PATH;
  if (options === undefined || options === null
    || (typeof options !== 'object' && typeof options !== 'function')) {
    fail('invalid_type', path, `${path} must be a plain options record.`);
  }
  assertNotProxy(options, path);
  if (!isPlainObject(options)) {
    fail('invalid_type', path, `${path} must be a plain options record.`);
  }
  let ownKeys;
  try {
    ownKeys = capturedOwnKeys(options);
  } catch {
    fail('invalid_type', path, `${path} keys could not be inspected safely.`);
  }
  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      fail('symbol_key_denied', `${path}[symbol]`,
        `${path}[symbol] carries a symbol-keyed property; options are direct data only.`);
    }
  }
  for (const key of ownKeys) {
    const descriptor = capturedDescriptor(options, key);
    if (!descriptor || !descriptor.enumerable) {
      fail('non_enumerable_property_denied', path,
        `${path} carries a non-enumerable own property; options are plain data.`);
    }
  }
  if (PRIVATE_ENTRIES[slot].option_contract.mode !== 'transport_property') {
    // The accepted factory owns this bag's full closed vocabulary and
    // already quarantines proxies, accessors, symbols, unknown keys, and
    // exotic prototypes; the registry forwards it without reinterpretation.
    return PRIVATE_COMPOSERS[slot](options);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'transport') {
      fail('unknown_key', path, `${path} carries a key outside the closed registry vocabulary.`);
    }
  }
  if (!hasOwn(options, 'transport')) {
    fail('missing_key', `${path}.transport`,
      `${path}.transport is required; the registry inherits no hidden transport default.`);
  }
  const descriptor = capturedDescriptor(options, 'transport');
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    fail('accessor_property_denied', `${path}.transport`,
      `${path}.transport is an accessor property; transports are concrete method objects only.`);
  }
  return PRIVATE_COMPOSERS[slot](descriptor.value);
}

capturedFreeze(detachData);
capturedFreeze(registrySlotsV1);
capturedFreeze(isRegistrySlotV1);
capturedFreeze(requireRegistrySlotV1);
capturedFreeze(registryEntryV1);
capturedFreeze(registryComposeFunctionV1);
capturedFreeze(describeProviderRegistryV1);
capturedFreeze(resolveRegistrySelectionV1);
capturedFreeze(composeProviderDriverV1);
