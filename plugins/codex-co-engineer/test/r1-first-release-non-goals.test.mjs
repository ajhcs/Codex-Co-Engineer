import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_IDS,
  ARCHITECTURE_IDS,
  GATE_A_OBLIGATION_IDS,
  NON_GOAL_IDS,
  PROFILE_BOUNDARY_IDS,
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

  for (const id of [...ARCHITECTURE_IDS, ...GATE_A_OBLIGATION_IDS, ...NON_GOAL_IDS, ...ALLOWED_IDS]) {
    assert.match(docs.adrText, new RegExp(`\`${id}\``, 'u'), `ADR missing ${id}`);
  }
  for (const id of PROFILE_BOUNDARY_IDS) {
    assert.match(docs.adrText, new RegExp(`\`${id}\``, 'u'), `ADR missing profile boundary ${id}`);
  }
  for (const id of THREAT_MODEL_IDS) {
    assert.match(docs.threatText, new RegExp(`\`${id}\``, 'u'), `threat model missing ${id}`);
  }

  assert.match(docs.adrText, /Profiles are \*\*data-only\*\*/u);
  assert.match(docs.adrText, /VerificationPolicyV1/u);
  assert.match(docs.adrText, /necessary but not sufficient/iu);
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
  assert.match(docs.adrText, /refs\/codex-co-engineer\/runs\/<run-id>\/candidate/u);
  assert.match(docs.adrText, /`incomplete_candidate` and can never receive `ready_for_codex_review`/u);
  assert.match(docs.adrText, /Waiting never silently extends a deadline/u);
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

test('first-release contract rejects profile executable-catalog language and missing Gate A obligations', async () => {
  const docs = await loadR1Docs();

  const profileExecutableCatalog = {
    ...docs,
    adrText: `${docs.adrText}\nA profile may name provider, role, expected duration, and a verification command catalog.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(profileExecutableCatalog),
    /re-authorizes executable profile content/u,
  );

  const profileMayDefineExecutable = {
    ...docs,
    threatText: `${docs.threatText}\nA profile may define executables and argv for verification.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(profileMayDefineExecutable),
    /re-authorizes executable profile content/u,
  );

  const profileContainsRunnableCatalog = {
    ...docs,
    adrText: `${docs.adrText}\nThe verification catalog inside a profile may contain runnable command entries.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(profileContainsRunnableCatalog),
    /re-authorizes executable profile content/u,
  );

  const providerCommandAuthorization = {
    ...docs,
    adrText: `${docs.adrText}\nProvider-requested commands may be executed automatically when the operator approves them once.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(providerCommandAuthorization),
    /re-authorizes provider-command execution/u,
  );

  const providerCommandActorAutoRun = {
    ...docs,
    threatText: `${docs.threatText}\nThe platform runs provider-requested commands automatically.\n`,
  };
  assert.throws(
    () => assertR1FirstReleaseContract(providerCommandActorAutoRun),
    /re-authorizes provider-command execution/u,
  );

  for (const sentence of [
    'Provider-reported commands may be run automatically.',
    'Provider-requested commands are executed automatically.',
    'Workers run provider-reported commands automatically.',
    'The platform supervisor executes provider-reported/requested commands automatically.',
    'Execution of provider-reported commands happens automatically.',
    'Approval of provider-requested commands authorizes execution.',
    'Provider-reported commands must be executed by the verifier.',
    'The policy permitted operator-approved provider-requested commands to run.',
  ]) {
    assert.throws(
      () => assertR1FirstReleaseContract({
        ...docs,
        securityText: `${docs.securityText}\n${sentence}\n`,
      }),
      /re-authorizes provider-command execution/u,
      sentence,
    );
  }

  const refusalAndEvidenceLanguage = {
    adrText: `${docs.adrText}\nThe policy permits Codex to decline provider-requested commands before execution.\n`,
    threatText: `${docs.threatText}\nOperators may approve provider-reported commands as evidence attachments without execution.\n`,
    securityText: docs.securityText,
  };
  assert.doesNotThrow(
    () => assertR1FirstReleaseContract(refusalAndEvidenceLanguage),
  );

  for (const sentence of [
    'The platform must not allow provider-reported commands to run.',
    'The verifier does not permit provider-requested commands for automatic execution.',
    'Workers never run provider-reported/requested commands automatically.',
  ]) {
    assert.doesNotThrow(
      () => assertR1FirstReleaseContract({
        ...docs,
        securityText: `${docs.securityText}\n${sentence}\n`,
      }),
      sentence,
    );
  }

  const missingGateAObligation = {
    ...docs,
    adrText: docs.adrText.replace('`gate_a_no_duplicate_dispatch`\n', ''),
  };
  assert.throws(
    () => assertR1FirstReleaseContract(missingGateAObligation),
    /gate_a_no_duplicate_dispatch/u,
  );

  const missingNecessaryNotSufficient = {
    ...docs,
    adrText: docs.adrText.replace('`gate_a_exact_tree_package_necessary_not_sufficient`\n', ''),
  };
  assert.throws(
    () => assertR1FirstReleaseContract(missingNecessaryNotSufficient),
    /gate_a_exact_tree_package_necessary_not_sufficient/u,
  );
});
