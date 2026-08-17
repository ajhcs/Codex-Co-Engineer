// Cursor owns the model catalog.  Keep this module deliberately provider
// agnostic: model IDs and parameter values are data returned by /v1/models,
// never a list maintained by the plugin.

export const DEFAULT_MODEL_CATALOG_MAX_ITEMS = 100;
export const MAX_MODEL_CATALOG_MAX_ITEMS = 256;
export const DEFAULT_MODEL_CATALOG_TTL_MS = 15_000;
export const MAX_MODEL_CATALOG_TTL_MS = 300_000;
export const DEFAULT_MODEL_SUMMARY_MAX_ITEMS = 20;

const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_TEXT_LENGTH = 512;
const MAX_MODEL_ALIASES = 32;
const MAX_MODEL_PARAMETERS = 32;
const MAX_MODEL_PARAMETER_VALUES = 64;
const MAX_MODEL_VARIANTS = 64;
const MAX_VARIANT_PARAMS = 32;
const TRUNCATION_FLAGS = Object.freeze([
  'truncated', 'pageTruncated', 'displayNameTruncated', 'descriptionTruncated',
  'aliasesTruncated', 'parametersTruncated', 'valuesTruncated', 'variantsTruncated',
]);

export class ModelCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelCatalogError';
    this.code = code;
  }
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedOption(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ModelCatalogError('invalid_configuration', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function identifier(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_MODEL_ID_LENGTH) {
    throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  }
  return value;
}

function text(value, field, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.length < 1)) {
    throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  }
  if (value.length <= MAX_MODEL_TEXT_LENGTH) return value;
  return value.slice(0, MAX_MODEL_TEXT_LENGTH);
}

function setText(output, key, value, field, options = {}) {
  const normalized = text(value, field, options);
  if (normalized === undefined) return;
  output[key] = normalized;
  if (typeof value === 'string' && value.length > MAX_MODEL_TEXT_LENGTH) output[`${key}Truncated`] = true;
}

function copyTruncationFlags(input, output) {
  for (const key of TRUNCATION_FLAGS) if (input?.[key] === true) output[key] = true;
}

function copyParam(value, field) {
  if (!record(value)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  const output = {
    id: identifier(value.id, `${field}.id`),
    value: identifier(value.value, `${field}.value`),
  };
  return output;
}

function copyParameterValue(value, field) {
  if (!record(value)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  const output = { value: identifier(value.value, `${field}.value`) };
  setText(output, 'displayName', value.displayName, `${field}.displayName`);
  copyTruncationFlags(value, output);
  return output;
}

function copyParameter(value, index) {
  const field = `model.parameters[${index}]`;
  if (!record(value) || !Array.isArray(value.values) || value.values.length < 1) {
    throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  }
  const output = {
    id: identifier(value.id, `${field}.id`),
    values: value.values.slice(0, MAX_MODEL_PARAMETER_VALUES).map((entry, valueIndex) => copyParameterValue(entry, `${field}.values[${valueIndex}]`)),
  };
  setText(output, 'displayName', value.displayName, `${field}.displayName`);
  if (value.values.length > MAX_MODEL_PARAMETER_VALUES) output.valuesTruncated = true;
  copyTruncationFlags(value, output);
  return output;
}

function copyVariant(value, index) {
  const field = `model.variants[${index}]`;
  if (!record(value) || !Array.isArray(value.params) || value.params.length > MAX_VARIANT_PARAMS) {
    throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  }
  const output = {
    params: value.params.map((entry, paramIndex) => copyParam(entry, `${field}.params[${paramIndex}]`)),
  };
  setText(output, 'displayName', value.displayName, `${field}.displayName`, { required: true });
  setText(output, 'description', value.description, `${field}.description`);
  if (value.isDefault !== undefined) {
    if (typeof value.isDefault !== 'boolean') throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.isDefault.`);
    output.isDefault = value.isDefault;
  }
  copyTruncationFlags(value, output);
  return output;
}

function copyModel(value, index) {
  const field = `items[${index}]`;
  if (!record(value)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.`);
  const output = {
    id: identifier(value.id, `${field}.id`),
  };
  setText(output, 'displayName', value.displayName, `${field}.displayName`, { required: true });
  setText(output, 'description', value.description, `${field}.description`);

  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.aliases.`);
    output.aliases = value.aliases.slice(0, MAX_MODEL_ALIASES).map((alias, aliasIndex) => identifier(alias, `${field}.aliases[${aliasIndex}]`));
    if (value.aliases.length > MAX_MODEL_ALIASES) output.aliasesTruncated = true;
  }
  if (value.parameters !== undefined) {
    if (!Array.isArray(value.parameters)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.parameters.`);
    output.parameters = value.parameters.slice(0, MAX_MODEL_PARAMETERS).map((entry, parameterIndex) => copyParameter(entry, parameterIndex));
    if (value.parameters.length > MAX_MODEL_PARAMETERS) output.parametersTruncated = true;
  }
  if (value.variants !== undefined) {
    if (!Array.isArray(value.variants)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid ${field}.variants.`);
    output.variants = value.variants.slice(0, MAX_MODEL_VARIANTS).map((entry, variantIndex) => copyVariant(entry, variantIndex));
    if (value.variants.length > MAX_MODEL_VARIANTS) output.variantsTruncated = true;
  }
  copyTruncationFlags(value, output);
  return output;
}

/**
 * Return only the identity fields needed for routine model selection. The
 * full bounded parameters/variants remain available through `detail: true`.
 */
export function summarizeModelCatalog(response, { limit = DEFAULT_MODEL_SUMMARY_MAX_ITEMS } = {}) {
  const itemLimit = boundedOption(limit, 'limit', 1, MAX_MODEL_CATALOG_MAX_ITEMS, DEFAULT_MODEL_SUMMARY_MAX_ITEMS);
  if (!record(response) || !Array.isArray(response.items)) {
    throw new ModelCatalogError('invalid_model_catalog', 'Cursor returned an invalid model catalog.');
  }
  const items = response.items.slice(0, itemLimit).map((item, index) => {
    if (!record(item)) throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid items[${index}].`);
    const output = {
      id: identifier(item.id, `items[${index}].id`),
    };
    setText(output, 'displayName', item.displayName, `items[${index}].displayName`, { required: true });
    if (item.aliases !== undefined && !Array.isArray(item.aliases)) {
      throw new ModelCatalogError('invalid_model_catalog', `Cursor returned an invalid items[${index}].aliases.`);
    }
    if (Array.isArray(item.aliases) && item.aliases.length > 0) {
      output.aliases = item.aliases.slice(0, MAX_MODEL_ALIASES).map((alias, aliasIndex) => identifier(alias, `items[${index}].aliases[${aliasIndex}]`));
      if (item.aliases.length > MAX_MODEL_ALIASES) output.aliasesTruncated = true;
    }
    copyTruncationFlags(item, output);
    return output;
  });
  return {
    items,
    // A source-truncated catalog is only a lower bound; do not present the
    // bounded visible length as an exact provider count.
    modelCount: response.truncated === true ? null : response.items.length,
    ...(response.truncated === true ? { truncated: true } : {}),
    ...(response.pageTruncated === true || response.items.length > itemLimit ? { pageTruncated: true } : {}),
  };
}

/**
 * Project the authenticated Cursor response into a bounded, API-shaped
 * catalog.  The IDs, aliases, parameter values, variants, and defaults are
 * copied from Cursor; no model name is invented locally.  Long descriptive
 * text is clipped only to keep routine status responses small.
 */
export function compactModelCatalog(response, { maxItems = DEFAULT_MODEL_CATALOG_MAX_ITEMS } = {}) {
  const itemLimit = boundedOption(maxItems, 'maxItems', 1, MAX_MODEL_CATALOG_MAX_ITEMS, DEFAULT_MODEL_CATALOG_MAX_ITEMS);
  if (!record(response) || !Array.isArray(response.items)) {
    throw new ModelCatalogError('invalid_model_catalog', 'Cursor returned an invalid model catalog.');
  }
  const output = {
    items: response.items.slice(0, itemLimit).map(copyModel),
  };
  if (response.truncated === true || response.items.length > itemLimit) output.truncated = true;
  if (response.pageTruncated === true) output.pageTruncated = true;
  // Keep a future-compatible cursor only when Cursor actually supplies one;
  // the current endpoint does not document pagination controls.
  if (response.nextCursor !== undefined) {
    output.nextCursor = identifier(response.nextCursor, 'nextCursor');
  }
  return output;
}

function compactModelReference(value, field = 'model') {
  if (typeof value === 'string') return { id: identifier(value, `${field}.id`) };
  if (!record(value)) throw new ModelCatalogError('invalid_model_selection', `The ${field} must be a Cursor model reference.`);
  const output = { id: identifier(value.id, `${field}.id`) };
  if (value.params !== undefined) {
    if (!Array.isArray(value.params) || value.params.length > MAX_VARIANT_PARAMS) {
      throw new ModelCatalogError('invalid_model_selection', `The ${field}.params are invalid.`);
    }
    output.params = value.params.map((entry, index) => copyParam(entry, `${field}.params[${index}]`));
  }
  return output;
}

/**
 * Summarize model selection without treating a requested model as proof of
 * the provider's effective model. Cursor's official Cloud Agents API does not
 * document a resolved-model field, so effective selection stays unknown until
 * the API contract adds one.
 */
export function summarizeModelSelection(requestedModel) {
  const requested = requestedModel === undefined || requestedModel === null
    ? null
    : compactModelReference(requestedModel, 'requestedModel');
  return {
    requested,
    requestedSource: requested === null ? 'account-default' : 'caller',
    effective: null,
    effectiveKnown: false,
    effectiveSource: 'unknown',
  };
}

function clone(value) {
  return structuredClone(value);
}

/**
 * A small in-process cache for repeated status calls.  It caches only a
 * successful bounded projection, never credentials or raw provider payloads;
 * callers can force an authenticated refresh when they need the current
 * catalog immediately.
 */
export class ModelCatalogCache {
  constructor({
    ttlMs = DEFAULT_MODEL_CATALOG_TTL_MS,
    maxItems = DEFAULT_MODEL_CATALOG_MAX_ITEMS,
    now = Date.now,
  } = {}) {
    this.ttlMs = boundedOption(ttlMs, 'ttlMs', 0, MAX_MODEL_CATALOG_TTL_MS, DEFAULT_MODEL_CATALOG_TTL_MS);
    this.maxItems = boundedOption(maxItems, 'maxItems', 1, MAX_MODEL_CATALOG_MAX_ITEMS, DEFAULT_MODEL_CATALOG_MAX_ITEMS);
    if (typeof now !== 'function') throw new ModelCatalogError('invalid_configuration', 'now must be a function.');
    this.now = now;
    this.entry = null;
    this.inFlight = null;
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.entry = null;
    // A clear must also detach the old promise. Otherwise a request already
    // in flight could be reused after clear and repopulate the next read with
    // a catalog from the previous generation.
    this.inFlight = null;
  }

  async get(loader, { forceRefresh = false } = {}) {
    if (typeof loader !== 'function') throw new ModelCatalogError('invalid_configuration', 'A model catalog loader is required.');
    const now = this.now();
    if (!forceRefresh && this.entry && this.entry.expiresAt > now) return clone(this.entry.value);
    if (!forceRefresh && this.inFlight) return clone(await this.inFlight);

    const generation = ++this.generation;
    const pending = Promise.resolve()
      .then(() => loader())
      .then((response) => {
        const value = compactModelCatalog(response, { maxItems: this.maxItems });
        if (generation === this.generation) {
          this.entry = { value, expiresAt: this.now() + this.ttlMs };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = null;
      });
    this.inFlight = pending;
    return clone(await pending);
  }
}
