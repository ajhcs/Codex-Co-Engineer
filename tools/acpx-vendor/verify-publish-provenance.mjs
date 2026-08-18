import { execFile as execFileCallback } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(vendorRoot, 'package.json');
const packageLockPath = join(vendorRoot, 'package-lock.json');

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const PACKAGE_SPEC = 'acpx@0.13.0';
const METADATA_URL = `${REGISTRY_ORIGIN}/acpx/0.13.0`;
const EXPECTED_REPOSITORY_URL = 'git+https://github.com/openclaw/acpx.git';
const EXPECTED_GIT_HEAD = '47dc1c56b20da3c248a4a1b5c5106f52e65e6594';
const EXPECTED_INTEGRITY = 'sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==';
const EXPECTED_TARBALL = `${REGISTRY_ORIGIN}/acpx/-/acpx-0.13.0.tgz`;
const EXPECTED_ATTESTATION_URL = `${REGISTRY_ORIGIN}/-/npm/v1/attestations/${PACKAGE_SPEC}`;
const EXPECTED_SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';
const EXPECTED_SUBJECT = 'pkg:npm/acpx@0.13.0';
const EXPECTED_WORKFLOW_REPOSITORY = 'https://github.com/openclaw/acpx';
const EXPECTED_WORKFLOW_REF = 'refs/tags/v0.13.0';
const EXPECTED_RESOLVED_DEPENDENCY = `git+${EXPECTED_WORKFLOW_REPOSITORY}@${EXPECTED_WORKFLOW_REF}`;
const EXPECTED_SHA512_HEX = Buffer.from(
  EXPECTED_INTEGRITY.slice('sha512-'.length),
  'base64',
).toString('hex');
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_DSSE_PAYLOAD_BYTES = 32 * 1024;
const MAX_AUDIT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_METADATA_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 60_000;
const DEFAULT_AUDIT_TIMEOUT_MS = 20_000;

const ERROR_MESSAGES = {
  metadata_unavailable: 'Public npm metadata could not be verified.',
  metadata_oversized: 'Public npm metadata exceeded the fixed response limit.',
  metadata_malformed: 'Public npm metadata was malformed.',
  attestation_unavailable: 'Public npm attestations could not be verified.',
  attestation_oversized: 'Public npm attestations exceeded the fixed response limit.',
  attestation_malformed: 'Public npm attestations were malformed.',
  provenance_mismatch: 'Published ACPX provenance did not match the exact release pin.',
  attested_payload_mismatch: 'The ACPX attestation payload did not match the exact source pin.',
  audit_cache_unavailable: 'The preseeded npm cache required for a clean offline audit install is unavailable.',
  audit_install_failed: 'The exact frozen lock could not be installed in the clean audit environment.',
  signature_audit_failed: 'npm signature and provenance verification failed.',
};

export class PublishProvenanceError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? 'ACPX publish provenance verification failed.');
    this.name = 'PublishProvenanceError';
    this.code = code;
  }
}

function fail(code) {
  throw new PublishProvenanceError(code);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedTimeout(value, maximum) {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

async function boundedResponseBytes(response, malformedCode, oversizedCode) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) fail(malformedCode);
    if (Number(declaredLength) > MAX_METADATA_BYTES) fail(oversizedCode);
  }
  if (!response.body) fail(malformedCode);

  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail(malformedCode);
      totalBytes += value.byteLength;
      if (totalBytes > MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => {});
        fail(oversizedCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function withDeadline(timeoutMs, unavailableCode, operation) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new PublishProvenanceError(unavailableCode));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function queryRegistryJson(fetchImpl, url, timeoutMs, codes) {
  try {
    return await withDeadline(timeoutMs, codes.unavailable, async (signal) => {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'user-agent': 'plumbob-acpx-publish-provenance/1',
        },
        signal,
      });
      if (!response || response.status !== 200) fail(codes.unavailable);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        fail(codes.malformed);
      }
      const bytes = await boundedResponseBytes(
        response,
        codes.malformed,
        codes.oversized,
      );
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        fail(codes.malformed);
      }
      try {
        return JSON.parse(text);
      } catch {
        fail(codes.malformed);
      }
    });
  } catch (error) {
    if (error instanceof PublishProvenanceError) throw error;
    fail(codes.unavailable);
  }
}

function queryMetadata(fetchImpl, timeoutMs) {
  return queryRegistryJson(fetchImpl, METADATA_URL, timeoutMs, {
    unavailable: 'metadata_unavailable',
    oversized: 'metadata_oversized',
    malformed: 'metadata_malformed',
  });
}

function queryAttestations(fetchImpl, attestationUrl, timeoutMs) {
  if (attestationUrl !== EXPECTED_ATTESTATION_URL) {
    fail('provenance_mismatch');
  }
  return queryRegistryJson(fetchImpl, attestationUrl, timeoutMs, {
    unavailable: 'attestation_unavailable',
    oversized: 'attestation_oversized',
    malformed: 'attestation_malformed',
  });
}

function validNpmSignature(value) {
  return isRecord(value)
    && typeof value.keyid === 'string'
    && /^SHA256:[A-Za-z0-9+/=]{20,256}$/u.test(value.keyid)
    && typeof value.sig === 'string'
    && /^[A-Za-z0-9+/=]{40,2048}$/u.test(value.sig);
}

function validateMetadata(metadata) {
  if (!isRecord(metadata)) fail('metadata_malformed');
  const repository = metadata.repository;
  const dist = metadata.dist;
  if (
    metadata.name !== 'acpx'
    || metadata.version !== '0.13.0'
    || !isRecord(repository)
    || repository.type !== 'git'
    || repository.url !== EXPECTED_REPOSITORY_URL
    || metadata.gitHead !== EXPECTED_GIT_HEAD
    || !isRecord(dist)
    || dist.integrity !== EXPECTED_INTEGRITY
    || dist.tarball !== EXPECTED_TARBALL
  ) {
    fail('provenance_mismatch');
  }

  const attestations = dist.attestations;
  if (
    !isRecord(attestations)
    || attestations.url !== EXPECTED_ATTESTATION_URL
    || !isRecord(attestations.provenance)
    || attestations.provenance.predicateType !== EXPECTED_SLSA_PREDICATE
    || !Array.isArray(dist.signatures)
    || dist.signatures.length < 1
    || dist.signatures.length > 16
    || !dist.signatures.every(validNpmSignature)
  ) {
    fail('provenance_mismatch');
  }

  return {
    package: PACKAGE_SPEC,
    repository: 'openclaw/acpx',
    git_head: metadata.gitHead,
    integrity: dist.integrity,
    tarball: dist.tarball,
    slsa_predicate_type: attestations.provenance.predicateType,
    attestation_url: attestations.url,
    npm_signatures_present: true,
  };
}

function decodeSignedPayload(encodedPayload) {
  const maximumEncodedLength = 4 * Math.ceil(MAX_DSSE_PAYLOAD_BYTES / 3);
  if (
    typeof encodedPayload !== 'string'
    || encodedPayload.length < 4
    || encodedPayload.length > maximumEncodedLength
  ) {
    fail(encodedPayload?.length > maximumEncodedLength
      ? 'attestation_oversized'
      : 'attestation_malformed');
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(encodedPayload)
  ) {
    fail('attestation_malformed');
  }
  const payloadBytes = Buffer.from(encodedPayload, 'base64');
  if (payloadBytes.length < 1 || payloadBytes.length > MAX_DSSE_PAYLOAD_BYTES) {
    fail(payloadBytes.length > MAX_DSSE_PAYLOAD_BYTES
      ? 'attestation_oversized'
      : 'attestation_malformed');
  }
  if (payloadBytes.toString('base64') !== encodedPayload) {
    fail('attestation_malformed');
  }

  let payloadText;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
  } catch {
    fail('attestation_malformed');
  }
  try {
    return JSON.parse(payloadText);
  } catch {
    fail('attestation_malformed');
  }
}

function validateAttestedPayloadBindings(attestationsResponse) {
  if (
    !isRecord(attestationsResponse)
    || !Array.isArray(attestationsResponse.attestations)
    || attestationsResponse.attestations.length > 32
  ) {
    fail('attestation_malformed');
  }
  const slsaEntries = attestationsResponse.attestations.filter(
    (entry) => isRecord(entry)
      && entry.predicateType === EXPECTED_SLSA_PREDICATE,
  );
  if (slsaEntries.length !== 1) fail('attested_payload_mismatch');

  const bundle = slsaEntries[0].bundle;
  const envelope = isRecord(bundle) ? bundle.dsseEnvelope : undefined;
  if (
    !isRecord(envelope)
    || envelope.payloadType !== 'application/vnd.in-toto+json'
  ) {
    fail('attestation_malformed');
  }

  const statement = decodeSignedPayload(envelope.payload);
  if (!isRecord(statement)) fail('attestation_malformed');
  const subject = statement.subject;
  const predicate = statement.predicate;
  const buildDefinition = isRecord(predicate)
    ? predicate.buildDefinition
    : undefined;
  const externalParameters = isRecord(buildDefinition)
    ? buildDefinition.externalParameters
    : undefined;
  const workflow = isRecord(externalParameters)
    ? externalParameters.workflow
    : undefined;
  const resolvedDependencies = isRecord(buildDefinition)
    ? buildDefinition.resolvedDependencies
    : undefined;
  const exactSubject = Array.isArray(subject) && subject.length === 1
    ? subject[0]
    : undefined;
  const subjectDigest = isRecord(exactSubject) ? exactSubject.digest : undefined;
  const exactDependency = Array.isArray(resolvedDependencies)
    && resolvedDependencies.length === 1
    ? resolvedDependencies[0]
    : undefined;
  const dependencyDigest = isRecord(exactDependency)
    ? exactDependency.digest
    : undefined;

  if (
    statement._type !== 'https://in-toto.io/Statement/v1'
    || statement.predicateType !== EXPECTED_SLSA_PREDICATE
    || !isRecord(exactSubject)
    || exactSubject.name !== EXPECTED_SUBJECT
    || !isRecord(subjectDigest)
    || Object.keys(subjectDigest).length !== 1
    || subjectDigest.sha512 !== EXPECTED_SHA512_HEX
    || !isRecord(workflow)
    || workflow.repository !== EXPECTED_WORKFLOW_REPOSITORY
    || workflow.ref !== EXPECTED_WORKFLOW_REF
    || !isRecord(exactDependency)
    || exactDependency.uri !== EXPECTED_RESOLVED_DEPENDENCY
    || !isRecord(dependencyDigest)
    || Object.keys(dependencyDigest).length !== 1
    || dependencyDigest.gitCommit !== EXPECTED_GIT_HEAD
  ) {
    fail('attested_payload_mismatch');
  }

  return {
    payload_binding_check: 'registry_dsse_payload_only',
    payload_subject: exactSubject.name,
    payload_sha512: subjectDigest.sha512,
    payload_workflow_repository: workflow.repository,
    payload_workflow_ref: workflow.ref,
    payload_git_commit: dependencyDigest.gitCommit,
  };
}

function defaultNpmCachePath(sourceEnvironment) {
  const configured = sourceEnvironment.ACPX_NPM_CACHE
    ?? sourceEnvironment.npm_config_cache
    ?? sourceEnvironment.NPM_CONFIG_CACHE;
  if (configured !== undefined) return configured;
  if (process.platform === 'win32' && sourceEnvironment.LOCALAPPDATA) {
    return join(sourceEnvironment.LOCALAPPDATA, 'npm-cache');
  }
  return join(homedir(), '.npm');
}

async function requireNpmCache(cachePath) {
  if (
    typeof cachePath !== 'string'
    || cachePath.length < 1
    || cachePath.length > 4096
    || !isAbsolute(cachePath)
  ) {
    fail('audit_cache_unavailable');
  }
  try {
    const cacheStat = await lstat(cachePath);
    if (!cacheStat.isDirectory()) fail('audit_cache_unavailable');
  } catch (error) {
    if (error instanceof PublishProvenanceError) throw error;
    fail('audit_cache_unavailable');
  }
}

function sanitizedNpmEnvironment(
  sourceEnvironment,
  cachePath,
  userConfig,
  globalConfig,
) {
  const environment = {
    FORCE_COLOR: '0',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    npm_config_cache: cachePath,
    npm_config_fund: 'false',
    npm_config_globalconfig: globalConfig,
    npm_config_registry: `${REGISTRY_ORIGIN}/`,
    npm_config_update_notifier: 'false',
    npm_config_userconfig: userConfig,
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = sourceEnvironment[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function runNpmSignatureAudit({
  execFileImpl = execFile,
  sourceEnvironment = process.env,
  timeoutMs = DEFAULT_AUDIT_TIMEOUT_MS,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  cachePath = defaultNpmCachePath(sourceEnvironment),
} = {}) {
  if (
    !isBoundedTimeout(timeoutMs, DEFAULT_AUDIT_TIMEOUT_MS)
    || !isBoundedTimeout(installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS)
  ) {
    fail('signature_audit_failed');
  }
  await requireNpmCache(cachePath);
  const auditRoot = await mkdtemp(join(tmpdir(), 'acpx-npm-signature-audit-'));
  const userConfig = join(auditRoot, 'user.npmrc');
  const globalConfig = join(auditRoot, 'global.npmrc');
  try {
    await Promise.all([
      copyFile(packageJsonPath, join(auditRoot, 'package.json')),
      copyFile(packageLockPath, join(auditRoot, 'package-lock.json')),
      writeFile(userConfig, `registry=${REGISTRY_ORIGIN}/\nalways-auth=false\n`, 'utf8'),
      writeFile(globalConfig, '', 'utf8'),
    ]);
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const childEnvironment = sanitizedNpmEnvironment(
      sourceEnvironment,
      cachePath,
      userConfig,
      globalConfig,
    );
    try {
      await execFileImpl(npmCommand, [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ], {
        cwd: auditRoot,
        encoding: 'utf8',
        env: childEnvironment,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
        timeout: installTimeoutMs,
        windowsHide: true,
      });
    } catch (error) {
      const boundedDiagnostic = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
        .slice(0, MAX_AUDIT_OUTPUT_BYTES);
      if (/ENOTCACHED|only-if-cached|offline[^\n]*cache|cache[^\n]*miss/iu.test(boundedDiagnostic)) {
        fail('audit_cache_unavailable');
      }
      fail('audit_install_failed');
    }

    let result;
    try {
      result = await execFileImpl(npmCommand, ['audit', 'signatures', '--json'], {
        cwd: auditRoot,
        encoding: 'utf8',
        env: childEnvironment,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_AUDIT_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch {
      fail('signature_audit_failed');
    }

    let audit;
    try {
      audit = JSON.parse(result.stdout);
    } catch {
      fail('signature_audit_failed');
    }
    if (
      !isRecord(audit)
      || !Array.isArray(audit.invalid)
      || !Array.isArray(audit.missing)
      || audit.invalid.length !== 0
      || audit.missing.length !== 0
    ) {
      fail('signature_audit_failed');
    }
    return {
      verified: true,
      invalid: 0,
      missing: 0,
      cryptographic_authority: 'npm_audit_signatures',
      environment: 'clean_frozen_offline_install',
    };
  } catch (error) {
    if (error instanceof PublishProvenanceError) throw error;
    fail('signature_audit_failed');
  } finally {
    try {
      await rm(auditRoot, { recursive: true, force: true });
    } catch {
      fail('signature_audit_failed');
    }
  }
}

export async function verifyRegistryPayloadBindings({
  fetchImpl = globalThis.fetch,
  metadataTimeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
} = {}) {
  if (
    typeof fetchImpl !== 'function'
    || !isBoundedTimeout(metadataTimeoutMs, DEFAULT_METADATA_TIMEOUT_MS)
  ) {
    fail('metadata_malformed');
  }
  const metadata = validateMetadata(
    await queryMetadata(fetchImpl, metadataTimeoutMs),
  );
  const payloadBindings = validateAttestedPayloadBindings(
    await queryAttestations(
      fetchImpl,
      metadata.attestation_url,
      metadataTimeoutMs,
    ),
  );
  return {
    payload_bindings_match: true,
    ...metadata,
    ...payloadBindings,
  };
}

export async function verifyPublishProvenance(options = {}) {
  const payloadBindings = await verifyRegistryPayloadBindings(options);
  const audit = await runNpmSignatureAudit();
  if (
    !isRecord(audit)
    || audit.verified !== true
    || audit.cryptographic_authority !== 'npm_audit_signatures'
    || audit.environment !== 'clean_frozen_offline_install'
  ) {
    fail('signature_audit_failed');
  }
  return {
    ok: true,
    ...payloadBindings,
    npm_signature_audit: 'verified',
    cryptographic_provenance_authority: audit.cryptographic_authority,
    npm_signature_audit_environment: audit.environment,
  };
}

async function main() {
  try {
    const localPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    if (localPackage.dependencies?.acpx !== '0.13.0') fail('provenance_mismatch');
    const result = await verifyPublishProvenance();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = error instanceof PublishProvenanceError
      ? error
      : new PublishProvenanceError('metadata_unavailable');
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: failure.code,
      message: failure.message,
    })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
