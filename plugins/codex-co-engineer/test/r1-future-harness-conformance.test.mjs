// Reusable P22 future-harness conformance suite. The kit is deterministic
// and may be pointed at the inert template or at a scripted future adapter.
// Passing it does not qualify a live transport.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindFutureHarnessDriverTemplateV1,
  createFutureHarnessDriverTemplateV1,
} from '../mcp/v3/future-harness.mjs';
import {
  describeFutureHarnessConformanceKitV1,
  runFutureHarnessConformanceKitV1,
} from '../mcp/v3/provider-driver-conformance.mjs';
import { bindProviderDriverV1, buildDriverOperationRequestV1 } from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  buildFutureHarnessFixtureV1,
  createScriptedFutureHarnessDriverV1,
  futureHarnessFailClosedDeclarationV1,
  futureHarnessSupportedDeclarationV1,
  futureHarnessTemplateOptionsV1,
} from './fixtures/r1-future-harness-conformance.mjs';

test('the conformance kit describes mock evidence and not live qualification', () => {
  const description = describeFutureHarnessConformanceKitV1();
  assert.equal(description.live_transport_qualification, false);
  assert.ok(description.proves.includes('preflight_before_spawn'));
  assert.ok(description.proves.includes('no_remote_pr_merge_authority'));
  assert.ok(description.proves.includes('no_secret_or_path_leakage'));
  assert.ok(Object.isFrozen(description));
});

test('the inert template passes the reusable kit deterministically', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  const driver = createFutureHarnessDriverTemplateV1(packed.options);
  const first = runFutureHarnessConformanceKitV1(driver, {
    label: 'template-dsh',
    declaration: packed.options.declaration,
    fixture: packed.fixture,
    expect: { launch_disposition: 'not_sent' },
  });
  const second = runFutureHarnessConformanceKitV1(
    createFutureHarnessDriverTemplateV1(packed.options),
    {
      label: 'template-dsh',
      declaration: packed.options.declaration,
      fixture: packed.fixture,
      expect: { launch_disposition: 'not_sent' },
    },
  );
  assert.equal(first.ok, true);
  assert.equal(first.live_transport_qualification, false);
  assert.equal(first.mode, 'not_sent');
  assert.deepEqual(first, second);
  assert.ok(first.checks >= 8);
});

test('the kit covers grok, cursor-local, and cursor-cloud fail-closed templates', () => {
  for (const provider of ['grok', 'cursor-local', 'cursor-cloud']) {
    const packed = futureHarnessTemplateOptionsV1(provider);
    const report = runFutureHarnessConformanceKitV1(
      createFutureHarnessDriverTemplateV1(packed.options),
      {
        label: `template-${provider}`,
        declaration: packed.options.declaration,
        fixture: packed.fixture,
        expect: { launch_disposition: 'not_sent' },
      },
    );
    assert.equal(report.ok, true, provider);
    assert.equal(report.live_transport_qualification, false, provider);
  }
});

test('blocked unattested preflight is a first-class kit mode', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh', {
    exact_model_selection: 'not_supported',
  });
  const report = runFutureHarnessConformanceKitV1(
    createFutureHarnessDriverTemplateV1(packed.options),
    {
      label: 'template-blocked',
      declaration: packed.options.declaration,
      fixture: packed.fixture,
      expect: { preflight_disposition: 'blocked' },
    },
  );
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'blocked');
});

test('a scripted dispatch double proves never-replay and terminal absorption', () => {
  const fixture = buildFutureHarnessFixtureV1('grok');
  const declaration = futureHarnessSupportedDeclarationV1('grok');
  const driver = createScriptedFutureHarnessDriverV1(fixture, {
    launch: 'dispatched',
    reconcile: 'terminal',
    cancel: 'already_terminal',
  });
  const report = runFutureHarnessConformanceKitV1(driver, {
    label: 'scripted-grok',
    declaration,
    fixture,
    expect: { launch_disposition: 'dispatched' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'dispatched');
  assert.equal(report.live_transport_qualification, false);
});

test('uncertain DSH dispatch never reports dispatched and never replays', () => {
  const fixture = buildFutureHarnessFixtureV1('dsh');
  const declaration = futureHarnessSupportedDeclarationV1('dsh');
  const driver = createScriptedFutureHarnessDriverV1(fixture, {
    launch: 'dispatch_uncertain',
    reconcile: 'terminal',
    cancel: 'already_terminal',
  });
  const report = runFutureHarnessConformanceKitV1(driver, {
    label: 'scripted-dsh',
    declaration,
    fixture,
    expect: { launch_disposition: 'dispatch_uncertain' },
  });
  assert.equal(report.ok, true);

  const lying = createScriptedFutureHarnessDriverV1(fixture, { launch: 'dispatched' });
  assert.throws(
    () => runFutureHarnessConformanceKitV1(lying, {
      label: 'dsh-dispatched-lie',
      declaration,
      fixture,
      expect: { launch_disposition: 'dispatched' },
    }),
    (error) => error instanceof RunContractV1Error
      && error.code === 'capability_dispatch_certainty_mismatch',
  );
});

test('unsupported cancel and reattach fail closed on a dispatched scripted driver', () => {
  const fixture = buildFutureHarnessFixtureV1('cursor-local');
  const declaration = futureHarnessFailClosedDeclarationV1('cursor-local');
  const driver = createScriptedFutureHarnessDriverV1(fixture, {
    launch: 'dispatched',
    reconcile: 'in_progress',
  });
  const report = runFutureHarnessConformanceKitV1(driver, {
    label: 'unsupported-local',
    declaration,
    fixture,
    expect: { launch_disposition: 'dispatched' },
  });
  assert.equal(report.ok, true);
});

test('the kit rejects a driver that invents a reply operation', () => {
  const packed = futureHarnessTemplateOptionsV1('dsh');
  const driver = {
    ...createFutureHarnessDriverTemplateV1(packed.options),
    reply: () => ({}),
  };
  assert.throws(
    () => runFutureHarnessConformanceKitV1(driver, {
      label: 'reply-inventor',
      declaration: packed.options.declaration,
      fixture: packed.fixture,
    }),
    (error) => error instanceof RunContractV1Error && error.code === 'invalid_surface',
  );
});

test('bound template and unbound template share the frozen caller identity', () => {
  const packed = futureHarnessTemplateOptionsV1('grok');
  const bound = bindFutureHarnessDriverTemplateV1(packed.options);
  bound.preflight(buildDriverOperationRequestV1('preflight', packed.fixture.envelope));
  const launch = bound.launch(buildDriverOperationRequestV1('launch', packed.fixture.envelope));
  assert.equal(launch.run_id, packed.fixture.identity.run_id);
  assert.equal(launch.assignment_id, packed.fixture.identity.assignment_id);
  assert.equal(launch.base_sha, packed.fixture.identity.base_sha);
});

test('scripted live_session_reply still has no reply method', () => {
  const fixture = buildFutureHarnessFixtureV1('grok');
  const declaration = futureHarnessSupportedDeclarationV1('grok');
  assert.equal(declaration.capability.same_session_reply, 'live_session_reply');
  const driver = createScriptedFutureHarnessDriverV1(fixture, {
    launch: 'dispatched',
    reconcile: 'unresolved_attention',
    cancel: 'cancel_requested',
  });
  assert.equal(Object.hasOwn(driver, 'reply'), false);
  const bound = bindProviderDriverV1(driver, declaration);
  bound.preflight(buildDriverOperationRequestV1('preflight', fixture.envelope));
  bound.launch(buildDriverOperationRequestV1('launch', fixture.envelope));
  const observe = bound.reconcile(buildDriverOperationRequestV1('reconcile', fixture.envelope));
  assert.equal(observe.disposition, 'unresolved_attention');
});
