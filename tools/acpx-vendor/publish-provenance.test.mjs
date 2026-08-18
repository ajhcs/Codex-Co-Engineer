import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PublishProvenanceError,
  runNpmSignatureAudit,
  verifyRegistryPayloadBindings,
} from './verify-publish-provenance.mjs';

const validMetadata = () => ({
  name: 'acpx',
  version: '0.13.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/openclaw/acpx.git',
  },
  gitHead: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
  dist: {
    integrity: 'sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==',
    tarball: 'https://registry.npmjs.org/acpx/-/acpx-0.13.0.tgz',
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/acpx@0.13.0',
      provenance: {
        predicateType: 'https://slsa.dev/provenance/v1',
      },
    },
    signatures: [{
      keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
      sig: 'MEYCIQCZNYGT7vd/avpjzfvg5whl1HzOjsG6Gm0OXfpW2Zv2tgIhAJxuTZFahYo+LGABYAv/8kduOSDgHulRI8wNUkE/kZjo',
    }],
  },
});

const validAttestationStatement = () => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{
    name: 'pkg:npm/acpx@0.13.0',
    digest: {
      sha512: '11d1a0331e68b18e1b36954dfbb7534d3ebb657b05ab1fe2b65e108c6613287fcdce6ddfa869962f713a16346456b9564698859d1362f89d65c5424f89ee259a',
    },
  }],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: 'https://github.com/openclaw/acpx',
          ref: 'refs/tags/v0.13.0',
          path: '/.github/workflows/release.yml',
        },
      },
      resolvedDependencies: [{
        uri: 'git+https://github.com/openclaw/acpx@refs/tags/v0.13.0',
        digest: {
          gitCommit: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
        },
      }],
    },
  },
});

function validAttestations(statement = validAttestationStatement()) {
  return {
    attestations: [{
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          payloadType: 'application/vnd.in-toto+json',
        },
      },
    }],
  };
}

function metadataResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function localVerifier({
  metadata = validMetadata(),
  attestations = validAttestations(),
  attestationFetch = () => metadataResponse(attestations),
  metadataTimeoutMs,
} = {}) {
  return verifyRegistryPayloadBindings({
    fetchImpl: async (url, options) => {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, undefined);
      if (url === 'https://registry.npmjs.org/acpx/0.13.0') {
        return metadataResponse(metadata);
      }
      assert.equal(
        url,
        'https://registry.npmjs.org/-/npm/v1/attestations/acpx@0.13.0',
      );
      return attestationFetch();
    },
    ...(metadataTimeoutMs === undefined ? {} : { metadataTimeoutMs }),
  });
}

test('checks exact registry metadata and attested payload bindings', async () => {
  const result = await localVerifier();
  assert.deepEqual(result, {
    payload_bindings_match: true,
    package: 'acpx@0.13.0',
    repository: 'openclaw/acpx',
    git_head: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
    integrity: 'sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==',
    tarball: 'https://registry.npmjs.org/acpx/-/acpx-0.13.0.tgz',
    slsa_predicate_type: 'https://slsa.dev/provenance/v1',
    attestation_url: 'https://registry.npmjs.org/-/npm/v1/attestations/acpx@0.13.0',
    npm_signatures_present: true,
    payload_binding_check: 'registry_dsse_payload_only',
    payload_subject: 'pkg:npm/acpx@0.13.0',
    payload_sha512: '11d1a0331e68b18e1b36954dfbb7534d3ebb657b05ab1fe2b65e108c6613287fcdce6ddfa869962f713a16346456b9564698859d1362f89d65c5424f89ee259a',
    payload_workflow_repository: 'https://github.com/openclaw/acpx',
    payload_workflow_ref: 'refs/tags/v0.13.0',
    payload_git_commit: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
  });
});

test('fails closed on identity, integrity, repository, or provenance mismatch', async () => {
  const invalidFixtures = [
    (metadata) => { metadata.gitHead = '0'.repeat(40); },
    (metadata) => { metadata.repository.url = 'git+https://github.com/example/acpx.git'; },
    (metadata) => { metadata.dist.integrity = 'sha512-invalid'; },
    (metadata) => { metadata.dist.tarball = 'https://example.invalid/acpx.tgz'; },
    (metadata) => { delete metadata.dist.attestations; },
    (metadata) => { metadata.dist.attestations.provenance.predicateType = 'https://example.invalid'; },
    (metadata) => { metadata.dist.signatures = []; },
  ];
  for (const mutate of invalidFixtures) {
    const metadata = validMetadata();
    mutate(metadata);
    await assert.rejects(localVerifier({ metadata }), (error) => (
      error instanceof PublishProvenanceError
      && error.code === 'provenance_mismatch'
    ));
  }
});

test('fails closed on malformed, oversized, or timed-out public metadata', async () => {
  await assert.rejects(
    verifyRegistryPayloadBindings({
      fetchImpl: async () => metadataResponse(validMetadata()),
      metadataTimeoutMs: 0,
    }),
    (error) => error.code === 'metadata_malformed',
  );
  await assert.rejects(
    verifyRegistryPayloadBindings({
      fetchImpl: async () => new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    (error) => error.code === 'metadata_malformed',
  );
  await assert.rejects(
    verifyRegistryPayloadBindings({
      fetchImpl: async () => new Response('x', {
        status: 200,
        headers: {
          'content-length': String(128 * 1024 + 1),
          'content-type': 'application/json',
        },
      }),
    }),
    (error) => error.code === 'metadata_oversized',
  );
  await assert.rejects(
    verifyRegistryPayloadBindings({
      fetchImpl: async () => new Promise(() => {}),
      metadataTimeoutMs: 5,
    }),
    (error) => error.code === 'metadata_unavailable',
  );
});

test('SLSA attestation payload binds the exact digest, repository, ref, and commit', async () => {
  const invalidFixtures = [
    (statement) => { statement.subject[0].digest.sha512 = '0'.repeat(128); },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.repository =
        'https://github.com/example/acpx';
    },
    (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.ref =
        'refs/heads/main';
    },
    (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
        '0'.repeat(40);
    },
  ];
  for (const mutate of invalidFixtures) {
    const statement = validAttestationStatement();
    mutate(statement);
    await assert.rejects(
      localVerifier({ attestations: validAttestations(statement) }),
      (error) => error.code === 'attested_payload_mismatch',
    );
  }
});

test('fails closed on missing, malformed, oversized, or redirected SLSA attestations', async () => {
  await assert.rejects(
    localVerifier({ attestations: { attestations: [] } }),
    (error) => error.code === 'attested_payload_mismatch',
  );

  for (const payload of [
    'not-base64!',
    Buffer.from('{').toString('base64'),
    `${validAttestations().attestations[0].bundle.dsseEnvelope.payload}=`,
  ]) {
    const attestations = validAttestations();
    attestations.attestations[0].bundle.dsseEnvelope.payload = payload;
    await assert.rejects(
      localVerifier({ attestations }),
      (error) => error.code === 'attestation_malformed',
    );
  }

  const oversizedPayload = validAttestations();
  oversizedPayload.attestations[0].bundle.dsseEnvelope.payload =
    'A'.repeat(4 * Math.ceil((32 * 1024) / 3) + 4);
  await assert.rejects(
    localVerifier({ attestations: oversizedPayload }),
    (error) => error.code === 'attestation_oversized',
  );

  await assert.rejects(
    localVerifier({
      attestationFetch: () => new Response('x', {
        status: 200,
        headers: {
          'content-length': String(128 * 1024 + 1),
          'content-type': 'application/json',
        },
      }),
    }),
    (error) => error.code === 'attestation_oversized',
  );
  await assert.rejects(
    localVerifier({
      attestationFetch: () => new Response('', {
        status: 302,
        headers: {
          'content-type': 'application/json',
          location: 'https://example.invalid/attestations',
        },
      }),
    }),
    (error) => error.code === 'attestation_unavailable',
  );
  await assert.rejects(
    localVerifier({
      attestationFetch: () => new Promise(() => {}),
      metadataTimeoutMs: 5,
    }),
    (error) => error.code === 'attestation_unavailable',
  );
});

test('npm signature audit uses bounded output, timeout, and credential-free environment', async () => {
  await assert.rejects(
    runNpmSignatureAudit({ timeoutMs: 0 }),
    (error) => error.code === 'signature_audit_failed',
  );
  await assert.rejects(
    runNpmSignatureAudit({
      cachePath: join(
        tmpdir(),
        `acpx-vendor-cache-missing-${process.pid}`,
      ),
    }),
    (error) => error.code === 'audit_cache_unavailable',
  );
  const captured = [];
  const result = await runNpmSignatureAudit({
    sourceEnvironment: {
      PATH: '/safe/bin',
      HOME: '/private/home',
      CODEX_HOME: '/private/codex',
      NODE_AUTH_TOKEN: 'secret',
      NPM_TOKEN: 'secret',
      npm_config__authToken: 'secret',
    },
    cachePath: tmpdir(),
    timeoutMs: 1234,
    execFileImpl: async (command, args, options) => {
      captured.push({ command, args, options });
      return args[0] === 'audit'
        ? { stdout: '{"invalid":[],"missing":[]}', stderr: '' }
        : { stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(result, {
    verified: true,
    invalid: 0,
    missing: 0,
    cryptographic_authority: 'npm_audit_signatures',
    environment: 'clean_frozen_offline_install',
  });
  assert.equal(captured.length, 2);
  assert.equal(captured[0].command, 'npm');
  assert.deepEqual(captured[0].args, [
    'ci',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepEqual(captured[1].args, ['audit', 'signatures', '--json']);
  assert.equal(captured[0].options.timeout, 60_000);
  assert.equal(captured[1].options.timeout, 1234);
  assert.equal(captured[1].options.maxBuffer, 64 * 1024);
  assert.equal(captured[1].options.killSignal, 'SIGKILL');
  assert.notEqual(captured[1].options.cwd, process.cwd());
  assert.equal(captured[1].options.env.PATH, '/safe/bin');
  assert.equal(captured[1].options.env.HOME, undefined);
  assert.equal(captured[1].options.env.CODEX_HOME, undefined);
  assert.equal(captured[1].options.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(captured[1].options.env.NPM_TOKEN, undefined);
  assert.equal(captured[1].options.env.npm_config__authToken, undefined);
  assert.equal(
    captured[1].options.env.npm_config_registry,
    'https://registry.npmjs.org/',
  );
  await assert.rejects(
    access(captured[1].options.env.npm_config_userconfig),
    { code: 'ENOENT' },
  );
});

test('fails closed when npm reports invalid or missing signatures', async () => {
  for (const stdout of [
    '{"invalid":[{"name":"acpx"}],"missing":[]}',
    '{"invalid":[],"missing":[{"name":"acpx"}]}',
    'not-json',
  ]) {
    await assert.rejects(
      runNpmSignatureAudit({
        cachePath: tmpdir(),
        execFileImpl: async (_command, args) => (
          args[0] === 'ci'
            ? { stdout: '', stderr: '' }
            : { stdout, stderr: 'sensitive text' }
        ),
      }),
      (error) => (
        error instanceof PublishProvenanceError
        && error.code === 'signature_audit_failed'
        && !error.message.includes('sensitive text')
      ),
    );
  }
  await assert.rejects(
    runNpmSignatureAudit({
      cachePath: tmpdir(),
      execFileImpl: async (_command, args) => {
        if (args[0] === 'ci') return { stdout: '', stderr: '' };
        throw new Error('timeout with NODE_AUTH_TOKEN=secret');
      },
    }),
    (error) => (
      error instanceof PublishProvenanceError
      && error.code === 'signature_audit_failed'
      && !error.message.includes('secret')
    ),
  );
  await assert.rejects(
    runNpmSignatureAudit({
      cachePath: tmpdir(),
      execFileImpl: async () => {
        const error = new Error('offline install failed');
        error.stderr = 'npm error code ENOTCACHED';
        throw error;
      },
    }),
    (error) => (
      error instanceof PublishProvenanceError
      && error.code === 'audit_cache_unavailable'
      && !error.message.includes('ENOTCACHED')
    ),
  );
});
