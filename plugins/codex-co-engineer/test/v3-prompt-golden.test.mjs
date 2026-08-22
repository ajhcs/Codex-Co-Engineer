// Stable-snapshot and Unicode-boundary tests for the P03 deterministic
// prompt compiler and identity digests. The committed golden fixtures pin
// the exact rendered child-envelope bytes and every identity digest for one
// fixed run; any template, framing, ordering, or canonicalization drift
// fails loudly here instead of silently changing dispatched children.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OBJECTIVE_MAX_BYTES,
  PROMPT_MAX_BYTES,
} from '../mcp/v3/run-manifest.mjs';
import {
  MAX_ENVELOPE_BYTES,
  compileChildEnvelopesV1,
  compileChildEnvelopeV1,
  parseChildEnvelopeV1,
} from '../mcp/v3/prompt-compiler.mjs';
import {
  assignmentPromptDigestV1,
  childEnvelopeDigestV1,
  runManifestDigestV1,
  verifyRunManifestDigestV1,
} from '../mcp/v3/identity.mjs';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v3-prompt-golden');
const readBytes = async (name) => readFile(path.join(FIXTURE_DIR, name));
const readJson = async (name) => JSON.parse(await readBytes(name));

function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value !== null && typeof value === 'object') {
    const rebuilt = {};
    for (const key of Object.keys(value).sort().reverse()) rebuilt[key] = reverseKeyOrder(value[key]);
    return rebuilt;
  }
  return value;
}

function exactUtf8Bytes(units, targetBytes) {
  const unitBytes = Buffer.byteLength(units, 'utf8');
  let characters = Array.from(units.repeat(Math.ceil(targetBytes / unitBytes)));
  while (Buffer.byteLength(characters.join(''), 'utf8') > targetBytes) characters.pop();
  const text = characters.join('');
  return text + 'a'.repeat(targetBytes - Buffer.byteLength(text, 'utf8'));
}

function boundaryManifest(prompt, objective) {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'unicode-boundary-run',
    repository: { path: '/run-fixtures/boundary', base_sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' },
    objective,
    assignments: [{
      assignment_id: 'boundary-lane',
      role: 'implement',
      access: 'writer',
      prompt,
      execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
      write_scope: ['src/**'],
      acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
      expected_duration_ms: 1_200_000,
      required_evidence: ['provider_report'],
    }],
    policy: {
      max_concurrency: 1,
      require_same_base: true,
      require_disjoint_writer_scopes: true,
      allow_post_dispatch_fallback: false,
      allow_merge: false,
      allow_create_pr: false,
      attention_mode: 'aggregate',
      completion_mode: 'all_settled_then_verify',
    },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

test('golden fixtures render byte-identical child envelopes', async () => {
  const manifest = await readJson('manifest.json');
  const envelopes = compileChildEnvelopesV1(manifest);
  assert.equal(envelopes.length, 3);
  for (const envelope of envelopes) {
    const golden = await readBytes(`${envelope.assignment_id}.envelope.txt`);
    assert.equal(
      Buffer.compare(Buffer.from(envelope.envelope_text, 'utf8'), golden), 0,
      `${envelope.assignment_id}.envelope.txt drifted from the committed snapshot`,
    );
    // The committed bytes must also survive a strict independent re-parse.
    const reparsed = parseChildEnvelopeV1(golden.toString('utf8'));
    assert.deepEqual(reparsed, envelope);
  }
});

test('golden identity digests match the committed snapshot exactly', async () => {
  const manifest = await readJson('manifest.json');
  const expected = await readJson('identity-digests.json');
  assert.equal(expected.schema, 'codex-co-engineer.identity.v1');

  const manifestDigest = runManifestDigestV1(manifest);
  assert.deepEqual(manifestDigest, expected.run_manifest);
  assert.equal(verifyRunManifestDigestV1(manifest, expected.run_manifest.digest), true);

  const envelopes = compileChildEnvelopesV1(manifest);
  for (const envelope of envelopes) {
    assert.deepEqual(
      assignmentPromptDigestV1(manifest, envelope.assignment_id),
      expected.assignment_prompts[envelope.assignment_id],
    );
    assert.deepEqual(
      childEnvelopeDigestV1(envelope),
      expected.child_envelopes[envelope.assignment_id],
    );
  }
  // The same snapshots hold for equivalent normalized forms of the manifest.
  const shuffled = reverseKeyOrder(JSON.parse(JSON.stringify(manifest)));
  assert.equal(runManifestDigestV1(shuffled).digest, expected.run_manifest.digest);
  assert.equal(assignmentPromptDigestV1(shuffled, 'backend-writer').digest,
    expected.assignment_prompts['backend-writer'].digest);
});

test('committed golden prompts stay opaque through normalization boundaries', async () => {
  const manifest = await readJson('manifest.json');
  const writer = compileChildEnvelopeV1(manifest, 'backend-writer');
  const goldenManifestText = (await readBytes('manifest.json')).toString('utf8');
  const embedded = JSON.parse(goldenManifestText).assignments[0].prompt;
  assert.equal(writer.prompt, embedded);
  // Framed offsets address the exact prompt bytes inside the committed file.
  const goldenBytes = await readBytes('backend-writer.envelope.txt');
  const { byte_offset: offset, byte_length: length } = writer.framed_blocks.prompt;
  assert.ok(goldenBytes.subarray(offset, offset + length).equals(Buffer.from(writer.prompt, 'utf8')));
});

test('prompts and objectives are hashed and framed correctly at UTF-8 boundaries', () => {
  const units = [
    ['ascii', 'a'],
    ['two-byte', '\u00e9'],
    ['three-byte', '\u20ac'],
    ['four-byte astral', '\u{1F98A}'],
    ['combining sequence', 'e\u0301'],
  ];
  for (const [name, unit] of units) {
    const prompt = `${exactUtf8Bytes(unit, PROMPT_MAX_BYTES - 1)}\n`;
    const objective = exactUtf8Bytes(unit, OBJECTIVE_MAX_BYTES);
    assert.equal(Buffer.byteLength(prompt, 'utf8'), PROMPT_MAX_BYTES, name);
    assert.equal(Buffer.byteLength(objective, 'utf8'), OBJECTIVE_MAX_BYTES, name);
    const [envelope] = compileChildEnvelopesV1(boundaryManifest(prompt, objective));
    assert.equal(envelope.envelope_byte_length <= MAX_ENVELOPE_BYTES, true, name);
    assert.equal(envelope.prompt, prompt, name);
    assert.equal(envelope.objective, objective, name);
    const bytes = Buffer.from(envelope.envelope_text, 'utf8');
    for (const block of ['objective', 'prompt']) {
      const { byte_offset: offset, byte_length: length } = envelope.framed_blocks[block];
      assert.ok(bytes.subarray(offset, offset + length).equals(
        Buffer.from(block === 'prompt' ? prompt : objective, 'utf8')), `${name}/${block}`);
    }
    // The final multi-byte character must never straddle the frame boundary.
    const promptEnd = envelope.framed_blocks.prompt.byte_offset + envelope.framed_blocks.prompt.byte_length;
    assert.equal(bytes[promptEnd], 0x0a, name);
    assert.equal(parseChildEnvelopeV1(envelope.envelope_text).prompt, prompt, name);
  }
});

test('opaque content keeps its exact bytes even when it fills every bound', () => {
  // Prompt ending on a complete four-byte character, and on a newline after
  // one; both must round-trip byte-exactly with no trailing ambiguity.
  for (const tail of ['', '\n']) {
    const prompt = exactUtf8Bytes('\u{1F98A}', PROMPT_MAX_BYTES - Buffer.byteLength(tail, 'utf8')) + tail;
    assert.equal(Buffer.byteLength(prompt, 'utf8'), PROMPT_MAX_BYTES);
    const [envelope] = compileChildEnvelopesV1(boundaryManifest(prompt, 'o'));
    assert.equal(envelope.prompt, prompt);
    assert.equal(parseChildEnvelopeV1(envelope.envelope_text).prompt, prompt);
    assert.equal(childEnvelopeDigestV1(envelope).digest,
      childEnvelopeDigestV1(parseChildEnvelopeV1(envelope.envelope_text)).digest);
  }
});

test('Unicode normalization differences are meaningful changes, never collapses', () => {
  const composed = boundaryManifest('R\u00e9sum\u00e9 drive-by fix.', 'objective o');
  const decomposed = boundaryManifest('Re\u0301sume\u0301 drive-by fix.', 'objective o');
  assert.notEqual(runManifestDigestV1(composed).digest, runManifestDigestV1(decomposed).digest);
  const composedEnvelope = compileChildEnvelopeV1(composed, 'boundary-lane');
  const decomposedEnvelope = compileChildEnvelopeV1(decomposed, 'boundary-lane');
  assert.notEqual(composedEnvelope.prompt, decomposedEnvelope.prompt);
  assert.notEqual(composedEnvelope.envelope_text, decomposedEnvelope.envelope_text);
  assert.notEqual(childEnvelopeDigestV1(composedEnvelope).digest, childEnvelopeDigestV1(decomposedEnvelope).digest);
  // Opaque bytes are hashed as-is: the decomposed form is genuinely longer.
  assert.ok(assignmentPromptDigestV1(decomposed, 'boundary-lane').input_bytes
    > assignmentPromptDigestV1(composed, 'boundary-lane').input_bytes);
});
