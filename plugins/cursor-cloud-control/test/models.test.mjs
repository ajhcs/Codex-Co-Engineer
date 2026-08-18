import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactModelCatalog,
  DEFAULT_MODEL_CATALOG_MAX_ITEMS,
  summarizeModelCatalog,
  ModelCatalogCache,
  ModelCatalogError,
  summarizeModelSelection,
} from '../mcp/models.mjs';
import { CursorApiClient } from '../mcp/client.mjs';

const modelItem = {
  id: 'provider-model-4.6',
  displayName: 'Provider Model 4.6',
  description: 'Returned by the authenticated provider catalog.',
  aliases: ['provider-latest', 'provider-stable'],
  parameters: [{
    id: 'reasoning',
    displayName: 'Reasoning',
    values: [
      { value: 'fast', displayName: 'Fast' },
      { value: 'deep', displayName: 'Deep' },
    ],
  }],
  variants: [{
    params: [{ id: 'reasoning', value: 'deep' }],
    displayName: 'Deep reasoning',
    description: 'The provider-defined deep variant.',
    isDefault: true,
  }],
};

test('compactModelCatalog preserves dynamic IDs, aliases, parameters, variants, and defaults', () => {
  const result = compactModelCatalog({ items: [modelItem] });
  assert.deepEqual(result, { items: [modelItem] });
  assert.equal(result.items[0].id, 'provider-model-4.6');
  assert.equal(result.items[0].variants[0].isDefault, true);
});
test('compactModelCatalog bounds catalog and nested provider data without inventing models', () => {
  const tooManyItems = Array.from({ length: DEFAULT_MODEL_CATALOG_MAX_ITEMS + 1 }, (_, index) => ({
    id: `model-${index}`,
    displayName: `Model ${index}`,
    parameters: [{
      id: 'mode',
      values: Array.from({ length: 65 }, (_, valueIndex) => ({ value: `value-${valueIndex}` })),
    }],
    variants: Array.from({ length: 65 }, (_, variantIndex) => ({
      params: [],
      displayName: `Variant ${variantIndex}`,
    })),
  }));
  const result = compactModelCatalog({ items: tooManyItems });
  assert.equal(result.items.length, DEFAULT_MODEL_CATALOG_MAX_ITEMS);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].parameters[0].values.length, 64);
  assert.equal(result.items[0].parameters[0].valuesTruncated, true);
  assert.equal(result.items[0].variants.length, 64);
  assert.equal(result.items[0].variantsTruncated, true);
});

test('compactModelCatalog fails closed on malformed provider catalogs', () => {
  assert.throws(() => compactModelCatalog({}), (error) => error instanceof ModelCatalogError && error.code === 'invalid_model_catalog');
  assert.throws(() => compactModelCatalog({ items: [{ displayName: 'missing id' }] }), (error) => error.code === 'invalid_model_catalog');
  assert.throws(() => compactModelCatalog({ items: [{ id: 'bad-params', displayName: 'Bad', parameters: [{ id: 'reasoning', values: [] }] }] }), (error) => error.code === 'invalid_model_catalog');
});

test('compactModelCatalog marks clipped descriptive text instead of implying it is complete', () => {
  const result = compactModelCatalog({ items: [{
    id: 'long-model-id',
    displayName: 'D'.repeat(513),
    description: 'x'.repeat(513),
    parameters: [{ id: 'reasoning', displayName: 'P'.repeat(513), values: [{ value: 'deep', displayName: 'Deep' }] }],
    variants: [{ params: [], displayName: 'V'.repeat(513), description: 'y'.repeat(513) }],
  }] });
  assert.equal(result.items[0].displayName.length, 512);
  assert.equal(result.items[0].displayNameTruncated, true);
  assert.equal(result.items[0].descriptionTruncated, true);
  assert.equal(result.items[0].parameters[0].displayName.length, 512);
  assert.equal(result.items[0].parameters[0].displayNameTruncated, true);
  assert.equal(result.items[0].variants[0].displayNameTruncated, true);
  assert.equal(result.items[0].variants[0].descriptionTruncated, true);
});

test('catalog summaries preserve truncation flags from the bounded source', () => {
  const bounded = compactModelCatalog({
    items: [{ id: 'flagged-model', displayName: 'Flagged', displayNameTruncated: true, aliases: ['flagged'], aliasesTruncated: true }],
    truncated: true,
    pageTruncated: true,
  });
  const summary = summarizeModelCatalog(bounded, { limit: 1 });
  assert.equal(summary.truncated, true);
  assert.equal(summary.pageTruncated, true);
  assert.equal(summary.items[0].displayNameTruncated, true);
  assert.equal(summary.items[0].aliasesTruncated, true);
});

test('summarizeModelCatalog keeps the default status payload compact and truthfully paged', () => {
  const result = summarizeModelCatalog({ items: [modelItem, { id: 'second-model', displayName: 'Second' }], truncated: true }, { limit: 1 });
  assert.deepEqual(result, {
    items: [{ id: 'provider-model-4.6', displayName: 'Provider Model 4.6', aliases: ['provider-latest', 'provider-stable'] }],
    modelCount: null,
    truncated: true,
    pageTruncated: true,
  });
});

test('summarizeModelSelection never infers an effective model from a request', () => {
  const requested = { id: 'provider-model-4.6', params: [{ id: 'reasoning', value: 'deep' }] };
  assert.deepEqual(summarizeModelSelection(requested, {}), {
    requested,
    requestedSource: 'caller',
    effective: null,
    effectiveKnown: false,
    effectiveSource: 'unknown',
  });
  assert.deepEqual(summarizeModelSelection(undefined), {
    requested: null,
    requestedSource: 'account-default',
    effective: null,
    effectiveKnown: false,
    effectiveSource: 'unknown',
  });
});

test('ModelCatalogCache deduplicates concurrent reads and returns bounded clones', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const cache = new ModelCatalogCache({ ttlMs: 1_000, maxItems: 1 });
  const loader = async () => {
    calls += 1;
    await blocked;
    return { items: [modelItem, { id: 'other', displayName: 'Other' }] };
  };
  const first = cache.get(loader);
  const second = cache.get(loader);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  a.items[0].id = 'mutated-locally';
  assert.equal((await cache.get(loader)).items[0].id, 'provider-model-4.6');
});

test('ModelCatalogCache supports explicit authenticated refresh and bounded expiry', async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new ModelCatalogCache({ ttlMs: 10, now: () => now });
  const loader = async () => ({ items: [{ id: `model-${++calls}`, displayName: `Model ${calls}` }] });
  assert.equal((await cache.get(loader)).items[0].id, 'model-1');
  assert.equal((await cache.get(loader)).items[0].id, 'model-1');
  assert.equal(calls, 1);
  assert.equal((await cache.get(loader, { forceRefresh: true })).items[0].id, 'model-2');
  now += 11;
  assert.equal((await cache.get(loader)).items[0].id, 'model-3');
  assert.equal(calls, 3);
});

test('ModelCatalogCache clear isolates an in-flight previous generation', async () => {
  const cache = new ModelCatalogCache({ ttlMs: 1_000 });
  let calls = 0;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const loader = async () => {
    const call = ++calls;
    if (call === 1) await firstGate;
    else await secondGate;
    return { items: [{ id: `generation-${call}`, displayName: `Generation ${call}` }] };
  };
  const stale = cache.get(loader);
  cache.clear();
  const current = cache.get(loader);
  releaseFirst();
  assert.equal((await stale).items[0].id, 'generation-1');
  releaseSecond();
  assert.equal((await current).items[0].id, 'generation-2');
  assert.equal((await cache.get(loader)).items[0].id, 'generation-2');
  assert.equal(calls, 2);
});

test('CursorApiClient models reads authenticated /v1/models through the bounded catalog cache', async () => {
  const calls = [];
  const client = new CursorApiClient({
    apiKey: 'unit-secret-value',
    origin: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ items: [modelItem] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const first = await client.models();
  const second = await client.models();
  const refreshed = await client.models({ forceRefresh: true });
  assert.deepEqual(first, second);
  assert.deepEqual(refreshed, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example.test/v1/models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer unit-secret-value');
});

test('CursorApiClient model caches are isolated per credential and origin', async () => {
  const calls = [];
  const makeClient = (apiKey, origin, id) => new CursorApiClient({
    apiKey,
    origin,
    fetchImpl: async (url) => {
      calls.push({ url: String(url), id });
      return new Response(JSON.stringify({ items: [{ id, displayName: id }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const first = makeClient('first-secret', 'https://first.example.test', 'first-model');
  const second = makeClient('second-secret', 'https://second.example.test', 'second-model');
  assert.equal((await first.models()).items[0].id, 'first-model');
  assert.equal((await second.models()).items[0].id, 'second-model');
  assert.equal((await first.models()).items[0].id, 'first-model');
  assert.equal((await second.models()).items[0].id, 'second-model');
  assert.deepEqual(calls.map((call) => call.id), ['first-model', 'second-model']);
});
