// Presentation truthfulness: lifecycle precedence, host-owned consent, and
// executed evidence versus planned assignments.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPERIENCE_COORDINATION,
  EXPERIENCE_PHRASES,
  EXPERIENCE_MAX_BYTES,
  projectExperience,
} from '../mcp/v3/response.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPLAY_ONLY = path.join(HERE, '..', 'mcp', 'v3', 'ui', 'display-only.js');
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function receipt(overrides = {}) {
  return {
    schema: 'codex-co-engineer.run-admission.v1',
    phase: 'running',
    status: 'running',
    run_id: 'presentation-run',
    assignment_count: 2,
    complete_candidate_blocked: true,
    lanes: [
      {
        assignment_id: 'writer',
        provider: 'grok',
        role: 'implement',
        required: true,
        phase: 'planned',
        status: 'planned',
        prompt_dispatched: false,
      },
      {
        assignment_id: 'review',
        provider: 'cursor-local',
        role: 'review',
        required: false,
        phase: 'planned',
        status: 'planned',
        prompt_dispatched: false,
      },
    ],
    ...overrides,
  };
}

test('pending repository consent stays attention and exposes a host-owned request', () => {
  const projected = projectExperience(receipt({
    phase: 'awaiting_consent',
    status: 'awaiting_consent',
    consent: {
      status: 'required',
      request: {
        kind: 'repository_exposure_consent',
        run_id: 'presentation-run',
        repository_identity: `sha256:${SHA}${SHA.slice(0, 24)}`,
        providers: ['grok', 'cursor-local'],
        scope: 'full_repository',
        duration: 'this_run_only',
        remote_mutation: false,
      },
    },
  }));

  assert.equal(projected.card, 'attention');
  assert.equal(projected.summary.attention, EXPERIENCE_PHRASES.attention);
  assert.equal(projected.summary.verified_final, null);
  assert.equal(projected.attention.consent.decision_authority, 'host');
  assert.equal(projected.attention.consent.request.scope, 'full_repository');
  assert.deepEqual(projected.attention.consent.request.providers, ['grok', 'cursor-local']);
  assert.match(projected.attention.consent.message, /approval.*full repository/iu);
  assert.equal(projected.attention.reply, null);
  assert.deepEqual(projected.attention.affected_lanes, ['review', 'writer']);
  assert.equal(projected.coordination.verified_final_decisions, 0);
  assert.equal(projected.coordination.actual.verified_final_decisions, 0);
  assert.equal(EXPERIENCE_COORDINATION.verified_final_decisions, 1);
});

test('explicit failed and cancelled lifecycles outrank planned-lane fallback', () => {
  for (const phase of ['failed', 'cancelled']) {
    const projected = projectExperience(receipt({ phase, status: phase }));
    assert.equal(projected.card, 'final', phase);
    assert.equal(projected.summary.verified_final, null, phase);
    assert.equal(projected.coordination.verified_final_decisions, 0, phase);
  }
});

test('planned tests and reviews remain absent until an observed outcome exists', () => {
  const planned = projectExperience(receipt({ phase: 'failed', status: 'failed', lanes: [
    { assignment_id: 'planned-review', provider: 'grok', role: 'review', status: 'planned', phase: 'planned' },
    { assignment_id: 'planned-tests', provider: 'grok', role: 'verify', status: 'planned', phase: 'planned' },
  ] }));
  assert.equal(planned.final.reviews.present, false);
  assert.deepEqual(planned.final.reviews.lanes, []);
  assert.deepEqual(planned.final.reviews.planned_lanes, ['planned-review']);
  assert.equal(planned.final.tests.present, false);
  assert.deepEqual(planned.final.tests.lanes, []);
  assert.deepEqual(planned.final.tests.planned_lanes, ['planned-tests']);

  const completed = projectExperience(receipt({
    phase: 'completed',
    status: 'completed',
    complete_candidate_blocked: false,
    journal: { terminal: true, run_outcome: 'completed' },
    lanes: [
      { assignment_id: 'completed-review', provider: 'grok', role: 'review', status: 'completed', phase: 'completed', prompt_dispatched: true },
      { assignment_id: 'completed-tests', provider: 'grok', role: 'verify', status: 'completed', phase: 'completed', prompt_dispatched: true },
    ],
    candidate: {
      composed: true,
      ready_for_codex_review: true,
      accepted: true,
      authority: 'p35',
    },
  }));
  assert.equal(completed.final.reviews.present, true);
  assert.deepEqual(completed.final.reviews.lanes, ['completed-review']);
  assert.equal(completed.final.tests.present, true);
  assert.deepEqual(completed.final.tests.lanes, ['completed-tests']);
  assert.equal(completed.summary.verified_final, EXPERIENCE_PHRASES.verified_final);
  assert.equal(completed.coordination.verified_final_decisions, 1);
  assert.equal(completed.coordination.actual.verified_final_decisions, 1);
});

test('display-only consent rendering has no reply or approval controls', async () => {
  const source = await readFile(DISPLAY_ONLY, 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: DISPLAY_ONLY });
  const ui = sandbox.CodexCoEngineerExperienceUi;
  const projected = projectExperience(receipt({
    phase: 'awaiting_consent',
    consent: {
      status: 'required',
      request: {
        kind: 'repository_exposure_consent',
        providers: ['grok'],
        scope: 'full_repository',
        duration: 'this_run_only',
        remote_mutation: false,
        repository_identity: `sha256:${SHA}${SHA.slice(0, 24)}`,
      },
    },
  }));
  const html = ui.renderConsentCardHtml(projected);
  assert.match(html, /Host-owned decision/u);
  assert.match(html, /full repository/u);
  assert.equal(ui.documentContainsActionControls(html), false);
  assert.equal(html.includes('tools/call'), false);
  const session = ui.createDisplayOnlySession({ card: 'attention' });
  assert.equal(session.paint(projected), true);
  assert.equal(session.outbound.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= EXPERIENCE_MAX_BYTES);
});
