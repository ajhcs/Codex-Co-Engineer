import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_IDS,
  ARCHITECTURE_IDS,
  NON_GOAL_IDS,
  R1_VERSION,
  THREAT_MODEL_IDS,
  assertR1FirstReleaseContract,
} from '../../../scripts/r1-first-release-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function readRepo(relative) {
  return readFile(path.join(REPO, relative), 'utf8');
}

async function loadR1Docs() {
  return {
    adrText: await readRepo('docs/adr/0001-r1-bounded-run-architecture.md'),
    threatText: await readRepo('docs/threat-model.md'),
    securityText: await readRepo('SECURITY.md'),
  };
}

test('R1 first-release docs keep 3.3.0 non-goals without forbidding allowed mechanisms', async () => {
  const docs = await loadR1Docs();
  assert.doesNotThrow(() => assertR1FirstReleaseContract(docs));

  assert.match(docs.adrText, /Product version: 3\.3\.0/u);
  assert.doesNotMatch(docs.adrText, /4\.0\.0/u);
  assert.doesNotMatch(docs.threatText, /4\.0\.0/u);
  assert.doesNotMatch(docs.securityText, /4\.0\.0/u);

  for (const id of [...ARCHITECTURE_IDS, ...NON_GOAL_IDS, ...ALLOWED_IDS]) {
    assert.match(docs.adrText, new RegExp(`\`${id}\``, 'u'), `ADR missing ${id}`);
  }
  for (const id of THREAT_MODEL_IDS) {
    assert.match(docs.threatText, new RegExp(`\`${id}\``, 'u'), `threat model missing ${id}`);
  }

  assert.match(docs.adrText, /Semantic or vector memory/u);
  assert.match(docs.adrText, /Cross-run knowledge or search/u);
  assert.match(docs.adrText, /LLM global compression/u);
  assert.match(docs.adrText, /Learned routing or cost prediction/u);
  assert.match(docs.adrText, /General DAG or branch inheritance/u);
  assert.match(docs.adrText, /Agent messaging or dynamic spawning beyond the submitted 1–8 assignments/u);
  assert.match(docs.adrText, /Debate, consensus, or automatic repair/u);
  assert.match(docs.adrText, /Protected-branch integration/u);
  assert.match(docs.adrText, /Automatic garbage collection of runs, worktrees, branches, or task state/u);

  assert.match(docs.adrText, /These non-goals do \*\*not\*\* forbid/u);
  assert.match(docs.adrText, /run-owned, single-parent, non-authoritative candidate/u);
  assert.match(docs.adrText, /Manual, proof-bound run cleanup/u);
  assert.match(docs.threatText, /This manual cleanup path is allowed/u);
  assert.match(docs.threatText, /do not forbid `run_owned_candidate_composition`/u);
});

test('first-release contract rejects missing non-goals and forbidden 3.3.0 claims', async () => {
  const docs = await loadR1Docs();

  const withoutMemoryNonGoal = {
    ...docs,
    adrText: docs.adrText.replace('`semantic_or_vector_memory`\n', ''),
  };
  assert.throws(
    () => assertR1FirstReleaseContract(withoutMemoryNonGoal),
    /semantic_or_vector_memory/u,
  );

  const forbidsComposition = {
    ...docs,
    adrText: `${docs.adrText}\nThe platform must not compose frozen verified child deltas.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(forbidsComposition),
    /must not forbid candidate composition/u,
  );

  const forbidsManualCleanup = {
    ...docs,
    threatText: `${docs.threatText}\nOperators must not perform manual run cleanup.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(forbidsManualCleanup),
    /must not forbid manual cleanup/u,
  );

  const wrongVersion = {
    ...docs,
    adrText: docs.adrText.replaceAll(R1_VERSION, '4.0.0'),
  };
  assert.throws(
    () => assertR1FirstReleaseContract(wrongVersion),
    /must not mention 4\.0\.0/u,
  );

  const compositionAsNonGoal = {
    ...docs,
    adrText: docs.adrText.replace(
      '- `automatic_gc`\n',
      '- `automatic_gc`\n- `run_owned_candidate_composition`\n',
    ),
  };
  assert.throws(
    () => assertR1FirstReleaseContract(compositionAsNonGoal),
    /must not forbid allowed mechanism run_owned_candidate_composition/u,
  );
});
