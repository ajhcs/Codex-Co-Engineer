// Atomic raw/sanitized artifact store (ADR 0001 identifiers
// `bounded_evidence`, `exact_identities`, Gate A
// `gate_a_valid_raw_and_sanitized_artifacts`).
//
// Additive v3 module for W4-P08. It binds validated ArtifactRefV1
// declarations to real bytes on disk under one caller-supplied existing
// PRIVATE store root, and it answers exactly three questions fail-closed:
//
//   1. publish  - do these bytes match this reference's declared claims, and
//                 can they become the one authoritative artifact at this
//                 reference's location atomically, idempotently, and without
//                 ever overwriting or partially exposing an artifact?
//   2. verify   - does the stored artifact at one reference's location still
//                 stream back to exactly its recorded length and digest?
//   3. audit    - is the whole bounded store tree structurally sound, free of
//                 foreign, torn, linked, or swapped entries, and fingerprint-
//                 identical across restarts?
//
// Storage layout under the private root - two disjoint class namespaces, so
// a raw artifact and a sanitized projection can never collide even at the
// same validated relative path:
//
//   <root>/raw/content/<relative_path>          authoritative bytes
//   <root>/raw/meta/<relative_path>.json        authoritative sidecar
//   <root>/sanitized/content/<relative_path>
//   <root>/sanitized/meta/<relative_path>.json
//
// The relative path is never reinterpreted: it arrives already validated by
// the accepted P07 grammar (relative, forward-slash, NFC, no dot aliases, no
// reserved device stems, no controls/invisibles/separator look-alikes), and
// this module maps it segment-for-segment beneath the class namespace.
// There is no parallel ref schema and no parallel path schema: references
// are parsed with parseArtifactRefV1 and nothing else, so traversal,
// absolute paths, device names, and Unicode tricks inherit the P07 denials
// verbatim while well-formed astral names stay legal.
//
// Publication contract:
//   - The source is a caller-supplied intrinsic Buffer/Uint8Array view or a
//     bounded async iterable of such views. Proxies, exotic prototypes,
//     SharedArrayBuffer-backed or subclass views, strings, accessor-shaped
//     iterables, and arbitrary class instances are denied before any byte is
//     read.
//   - Declared byte_length and sha256 are UNTRUSTED CLAIMS. Bytes stream
//     straight into a private unpredictable same-directory temporary file
//     while the class cap (sanitized 256 KiB, raw 32 MiB) is enforced on
//     every chunk BEFORE that chunk is written, so no declaration or hostile
//     stream can cause an over-allocation. Actual length and SHA-256 are
//     computed from the streamed bytes and must match the declared claims
//     exactly before anything is published.
//   - The temporary file is fsynced, then published by exclusive hardlink
//     onto its final name (link(2) refuses to clobber), the temporary name
//     is unlinked, and the parent directories are fsynced. There is no
//     window in which a partial artifact exists under an authoritative name.
//   - Exact same validated ref plus bytes is IDEMPOTENT: the loser of a race
//     re-verifies the winner's stored state and returns an equal receipt
//     marked created:false. Conflicting content at one location, the same
//     digest with mismatched metadata, or any other competing publication
//     fails closed with a typed content-free error and leaves the
//     authoritative state untouched (a race loser rolls its own just-linked
//     content back, but only after the platform proves the inode is ours).
//   - Roots and parents use descriptor/no-follow discipline: the root must
//     be an existing real owner-owned group/other-private directory opened
//     O_NOFOLLOW|O_DIRECTORY|O_NONBLOCK and identity-bracketed by
//     device/inode; every namespace and parent component is lstat-walked,
//     created 0700 when missing, and re-proven after publication, so root,
//     namespace, and parent swaps are rejected wherever the platform can
//     prove them.
//
// Verification and audit stream content in fixed chunks solely to recompute
// length and digest - artifact bytes are never returned, echoed, or buffered
// whole. Enumeration is bounded (per-directory entries, total files per
// namespace, nesting depth, and total streamed audit bytes), sidecars are
// bounded and strictly parsed, and symlinks, hardlinks, FIFOs/devices,
// leftover or torn temporaries, orphaned or missing sidecars, foreign names,
// oversized or truncated content, malformed metadata, and content swapped
// under a path are all rejected with typed errors.
//
// Results are detached deep-frozen metadata only: never artifact bytes,
// never the store root or any path derived from a reference, and never an
// operating-system error string. Errors carry stable codes from a closed
// vocabulary plus fixed validator-style field labels.
//
// Out of scope and deliberately unclaimed: P09 sanitization/transformation,
// the P10 model-facing bounded reader, the P13 evidence bundle, cleanup and
// garbage collection of any kind, scheduler/provider/supervisor wiring, and
// protected references. A store left torn by a crash stays torn: reopening,
// publishing, verifying, or auditing it fails closed, and only an operator
// action outside this module may remove anything.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import {
  ARTIFACT_CLASSES,
  ARTIFACT_DIGEST_DOMAIN,
  ARTIFACT_DIGEST_VERSION,
  MAX_RAW_ARTIFACT_BYTE_LENGTH,
  MAX_SANITIZED_ARTIFACT_BYTE_LENGTH,
  MIN_ARTIFACT_BYTE_LENGTH,
  artifactRefDigestV1,
  orderArtifactRefsV1,
  parseArtifactRefV1,
} from './artifact-ref.mjs';
import {
  ARTIFACT_PATH_MAX_SEGMENTS,
  validateArtifactRelativePathV1,
} from './artifact-path.mjs';
import {
  capturedCreate,
  capturedFreeze,
  capturedIncludes,
  capturedTest,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { RunContractV1Error } from './run-manifest.mjs';
import {
  assertDirectJsonClosure,
  assertPlainObject,
  fail,
  freezeData,
} from './selection-json.mjs';

export const ARTIFACT_STORE_SCHEMA_ID = 'codex-co-engineer.artifact-store.v1';

// Closed denial vocabulary. Shared vocabulary codes from the owning modules
// pass through unchanged: every artifact-ref, artifact-path, proxy, accessor,
// symbol-key, alias/cycle, unknown-key, and enum denial keeps its exact P07
// code and message shape.
export const ARTIFACT_STORE_ERROR_CODES = capturedFreeze([
  'artifact_content_conflict',
  'artifact_digest_mismatch',
  'artifact_entry_unsafe',
  'artifact_foreign_entry',
  'artifact_inventory_exceeded',
  'artifact_length_mismatch',
  'artifact_metadata_conflict',
  'artifact_metadata_malformed',
  'artifact_not_found',
  'artifact_parent_swapped',
  'artifact_parent_unsafe',
  'artifact_path_escapes_root',
  'artifact_reserved_name_denied',
  'artifact_root_missing',
  'artifact_root_unsafe',
  'artifact_stream_failed',
  'artifact_stream_invalid_chunk',
  'artifact_stream_invalid_source',
  'artifact_stream_over_cap',
  'artifact_torn_publication',
  'artifact_torn_temporary',
]);

export const ARTIFACT_STORE_NAMESPACES = capturedFreeze([...ARTIFACT_CLASSES]);

export const ARTIFACT_STORE_CONTENT_DIR = 'content';
export const ARTIFACT_STORE_META_DIR = 'meta';
export const ARTIFACT_STORE_META_SUFFIX = '.json';

// Sidecar documents are tiny canonical JSON; anything larger is malformed.
export const MAX_ARTIFACT_STORE_META_BYTES = 4096;
// Bounds that keep enumeration, allocation, and audit work finite.
export const MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES = 512;
export const MAX_ARTIFACT_STORE_AUDIT_FILES = 1024;
export const MAX_ARTIFACT_STORE_AUDIT_BYTES = 67_108_864;
export const ARTIFACT_STORE_INGEST_CHUNK_BYTES = 131_072;
export const ARTIFACT_STORE_MAX_DEPTH = ARTIFACT_PATH_MAX_SEGMENTS;

// Private unpredictable same-directory temporaries. The name grammar is
// reserved: no artifact path may look like a temporary, so verification can
// condemn every leftover without ambiguity.
const PRIVATE_TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f]{32}$/u;
export const ARTIFACT_STORE_TEMP_NAME_PATTERN = new RegExp(
  PRIVATE_TEMP_NAME_PATTERN.source, PRIVATE_TEMP_NAME_PATTERN.flags,
);

export const ARTIFACT_STORE_INVENTORY_LABEL = 'artifact-store-inventory.v1';

const PRIVATE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const META_KEYS = capturedFreeze(['schema', 'artifact_ref', 'byte_length', 'sha256']);

// ---- Captured intrinsics, taken exactly once at initialization. -----------
const CREATE_HASH = createHash;
const RANDOM_BYTES = randomBytes;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const BUFFER_IS_BUFFER = NodeBuffer.isBuffer;
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const BUFFER_ALLOC = Buffer.alloc.bind(Buffer);
const WRITE_BIGUINT64_BE = Buffer.prototype.writeBigUInt64BE;
const PATH_JOIN = path.join;
const PATH_DIRNAME = path.dirname;
const PATH_BASENAME = path.basename;
const PATH_RELATIVE = path.relative;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const STRING = String;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REFLECT_HAS = Reflect.has;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const IS_PROXY = utilTypes.isProxy;
const IS_ARRAY_BUFFER = utilTypes.isArrayBuffer;
const IS_SHARED_ARRAY_BUFFER = utilTypes.isSharedArrayBuffer;
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const JSON_PARSE = JSON.parse;
const SET_CTOR = Set;
const SYMBOL_ASYNC_ITERATOR = Symbol.asyncIterator;

const UINT8ARRAY_PROTOTYPE = Uint8Array.prototype;
const BUFFER_PROTOTYPE = Buffer.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const ASYNC_GENERATOR_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Object.getPrototypeOf((async function* () {}).prototype),
);

const ROOT_OPEN_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

// Per-root operation chains. Every operation on one store root is serialized
// behind a single promise chain keyed by the root's device/inode identity, so
// concurrent in-process submissions compose deterministically (identical
// submissions interleave into one winner plus idempotent losers; conflicting
// ones fail closed) while the kernel's exclusive link arbitrates any
// out-of-process race.
const STORE_CHAINS = new Map();

function diagnostic(message) {
  const text = STRING(message ?? '');
  return text.length <= 200 ? text : text.slice(0, 200);
}

function failStore(code, field, message) {
  fail(code, field, diagnostic(message));
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function maxByteLengthForClass(artifactClass) {
  return artifactClass === 'raw'
    ? MAX_RAW_ARTIFACT_BYTE_LENGTH
    : MAX_SANITIZED_ARTIFACT_BYTE_LENGTH;
}

// ---- Binary source hardening. ----------------------------------------------

// Accept only intrinsic Uint8Array/Buffer views over ordinary ArrayBuffers.
// Proxies, subclasses, SharedArrayBuffer backings, and accessor-dressed
// look-alikes are rejected without reading a single byte, so spoofed length
// properties cannot lie about how much work a source will cause.
function isIntrinsicBinaryView(value) {
  if (value === null || typeof value !== 'object') return false;
  if (IS_PROXY(value)) return false;
  const proto = OBJECT_GET_PROTOTYPE_OF(value);
  if (proto !== UINT8ARRAY_PROTOTYPE && proto !== BUFFER_PROTOTYPE) return false;
  if (!ARRAY_BUFFER_IS_VIEW(value)) return false;
  const backing = value.buffer;
  if (!IS_ARRAY_BUFFER(backing) || IS_SHARED_ARRAY_BUFFER(backing)) return false;
  return true;
}

// Accept only async iterables that cannot smuggle a getter execution: plain
// data objects carrying an own asyncIterator data property, null-prototype
// equivalents, or genuine async generators. Arbitrary class instances -
// including Node streams with prototype chains - are refused deterministically.
function isAcceptableAsyncIterable(source) {
  let proto = OBJECT_GET_PROTOTYPE_OF(source);
  for (let depth = 0; depth < 4 && proto !== null; depth += 1) {
    if (IS_PROXY(proto)) return false;
    if (proto === ASYNC_GENERATOR_PROTOTYPE) return true;
    if (proto === OBJECT_PROTOTYPE) break;
    proto = OBJECT_GET_PROTOTYPE_OF(proto);
  }
  if (proto !== null && proto !== OBJECT_PROTOTYPE) return false;
  if (!REFLECT_HAS(source, SYMBOL_ASYNC_ITERATOR)) return false;
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(source, SYMBOL_ASYNC_ITERATOR);
  if (descriptor === undefined || descriptor.get !== undefined) return false;
  return typeof descriptor.value === 'function';
}

function classifySource(source) {
  if (isIntrinsicBinaryView(source)) return { kind: 'bytes', value: source };
  if (source !== null && typeof source === 'object') {
    if (IS_PROXY(source)) {
      failStore('proxy_denied', 'source', 'The artifact source is a live or revoked Proxy.');
    }
    if (isAcceptableAsyncIterable(source)) return { kind: 'stream', value: source };
  }
  failStore('artifact_stream_invalid_source', 'source',
    'The artifact source must be an intrinsic Buffer/Uint8Array view or a bounded '
    + 'async iterable of such views.');
}

// ---- Root and parent-chain discipline. --------------------------------------

function assertSafeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failStore('artifact_root_unsafe', 'root',
      'The artifact store root must be an absolute directory path.');
  }
  if (!PATH_IS_ABSOLUTE(value) || value.includes('\0') || value.includes('\\')) {
    failStore('artifact_root_unsafe', 'root', 'The artifact store root must be an absolute, NUL-free path.');
  }
  if (value !== '/' && value.endsWith('/')) {
    failStore('artifact_root_unsafe', 'root', 'The artifact store root must not end with a slash.');
  }
  if (path.normalize(value) !== value) {
    failStore('artifact_root_unsafe', 'root', 'The artifact store root must be a normalized absolute path.');
  }
  for (const part of value.split('/')) {
    if (part === '.' || part === '..') {
      failStore('artifact_root_unsafe', 'root', 'The artifact store root must not contain dot segments.');
    }
  }
  return value;
}

function ownerUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function assertPrivateDirectory(stat, field, label) {
  if (stat.isSymbolicLink()) {
    failStore('artifact_parent_unsafe', field, `The artifact store ${label} must not be a symbolic link.`);
  }
  if (!stat.isDirectory()) {
    failStore('artifact_parent_unsafe', field, `The artifact store ${label} must be a real directory.`);
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failStore('artifact_root_unsafe', field, `The artifact store ${label} must be owned by the current user.`);
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failStore('artifact_root_unsafe', field,
      `The artifact store ${label} must be private (no group or other access).`);
  }
}

function assertRegularUnsharedFile(stat, field) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failStore('artifact_entry_unsafe', field, 'Stored artifacts must be regular non-symlink files.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(Number(stat.nlink)) || Number(stat.nlink) !== 1) {
    failStore('artifact_entry_unsafe', field, 'Stored artifacts must not be hardlinked.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failStore('artifact_entry_unsafe', field, 'Stored artifacts must be owned by the current user.');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failStore('artifact_entry_unsafe', field, 'Stored artifacts must be owner-only.');
  }
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function openRootHandle(rootPath) {
  let handle;
  try {
    handle = await open(rootPath, ROOT_OPEN_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      failStore('artifact_root_missing', 'root', 'The artifact store root does not exist.');
    }
    failStore('artifact_root_unsafe', 'root',
      'The artifact store root could not be opened as a real non-symlink directory.');
  }
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      failStore('artifact_root_unsafe', 'root', 'The artifact store root must be a real directory.');
    }
    assertPrivateDirectory(stat, 'root', 'root');
    return { handle, path: rootPath, dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function reopenRoot(token) {
  const opened = await openRootHandle(token.path);
  if (!sameIdentity(opened, token)) {
    await opened.handle.close().catch(() => {});
    failStore('artifact_root_unsafe', 'root', 'The artifact store root was replaced while the store was open.');
  }
  return opened;
}

// Map one validated relative path into its two namespace locations. The
// mapping is injective, and containment is proven defensively even though
// the P07 grammar already forbids traversal.
function namespaceLocations(rootPath, artifactClass, relativePath) {
  if (!capturedIncludes(ARTIFACT_CLASSES, artifactClass)) {
    failStore('invalid_format', 'artifact_class', 'The artifact class is not a known namespace.');
  }
  const segments = validateArtifactRelativePathV1(relativePath, 'artifact_ref.relative_path').segments;
  const classDir = PATH_JOIN(rootPath, artifactClass);
  const contentBase = PATH_JOIN(classDir, ARTIFACT_STORE_CONTENT_DIR);
  const metaBase = PATH_JOIN(classDir, ARTIFACT_STORE_META_DIR);
  const joined = PATH_JOIN('/', ...segments).slice(1);
  const contentTarget = `${contentBase}/${joined}`;
  const metaTarget = `${metaBase}/${joined}${ARTIFACT_STORE_META_SUFFIX}`;
  for (const [baseDir, target] of [[contentBase, contentTarget], [metaBase, metaTarget]]) {
    const escaped = PATH_RELATIVE(baseDir, target);
    if (PATH_IS_ABSOLUTE(escaped) || escaped === '' || escaped.startsWith('..')) {
      failStore('artifact_path_escapes_root', 'artifact_ref.relative_path',
        'The validated artifact path would leave its namespace; publication is refused.');
    }
  }
  return { contentTarget, metaTarget, contentBase, metaBase, segments };
}

// Walk (creating when absent) the directory chain beneath baseDir named by
// parentSegments, proving every component to be a real private directory and
// capturing identities so later swaps are provable.
async function ensureParentChain(baseDir, parentSegments, captures) {
  await ensurePrivateDirectory(baseDir, captures);
  let current = baseDir;
  for (let index = 0; index < parentSegments.length; index += 1) {
    current = PATH_JOIN(current, parentSegments[index]);
    await ensurePrivateDirectory(current, captures);
  }
  return captures;
}

async function ensurePrivateDirectory(dir, captures) {
  let stat = await lstat(dir).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    failStore('artifact_parent_unsafe', 'parent', 'A store directory could not be inspected.');
  });
  if (stat === undefined) {
    await mkdir(dir, { mode: 0o700 }).catch((error) => {
      if (error?.code === 'EEXIST') return;
      failStore('artifact_parent_unsafe', 'parent', 'A store directory could not be created.');
    });
    stat = await lstat(dir).catch(() => undefined);
    if (stat === undefined) {
      failStore('artifact_parent_unsafe', 'parent', 'A created store directory disappeared immediately.');
    }
  }
  assertPrivateDirectory(stat, 'parent', 'directory');
  captures.push({ path: dir, dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode) });
}

async function assertChainUnchanged(captures) {
  for (let index = 0; index < captures.length; index += 1) {
    const before = captures[index];
    const stat = await lstat(before.path).catch(() => undefined);
    if (stat === undefined) {
      failStore('artifact_parent_swapped', 'parent', 'A store directory vanished during publication.');
    }
    if (Number(stat.dev) !== before.dev || Number(stat.ino) !== before.ino
      || Number(stat.mode) !== before.mode) {
      failStore('artifact_parent_swapped', 'parent', 'A store directory was replaced during publication.');
    }
  }
}

// ---- Temporary files, exclusive publication, fsync discipline. ---------------

async function syncDirectoryOf(filePath) {
  let handle;
  try {
    handle = await open(PATH_DIRNAME(filePath), ROOT_OPEN_FLAGS);
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return;
    failStore('artifact_stream_failed', 'temporary', 'A store directory could not be synchronized.');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function createPrivateTemp(directory) {
  const target = PATH_JOIN(directory, `.tmp-${RANDOM_BYTES(16).toString('hex')}`);
  let handle;
  try {
    handle = await open(target, FILE_CREATE_FLAGS, 0o600);
  } catch {
    failStore('artifact_stream_failed', 'temporary',
      'A private unpredictable temporary file could not be created exclusively.');
  }
  try {
    await handle.chmod(0o600);
  } catch {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    failStore('artifact_stream_failed', 'temporary', 'A temporary file could not be kept owner-only.');
  }
  return { handle, path: target };
}

async function writeChunk(handle, view) {
  let written = 0;
  while (written < view.byteLength) {
    const end = Math.min(written + ARTIFACT_STORE_INGEST_CHUNK_BYTES, view.byteLength);
    const slice = view.subarray(written, end);
    let result;
    try {
      result = await handle.write(slice, 0, slice.byteLength);
    } catch {
      failStore('artifact_stream_failed', 'source', 'Artifact bytes could not be written to the temporary file.');
    }
    if (!NUMBER_IS_SAFE_INTEGER(result?.bytesWritten) || result.bytesWritten !== slice.byteLength) {
      failStore('artifact_stream_failed', 'source', 'A write to the temporary file was short.');
    }
    written += result.bytesWritten;
  }
}

// Remove one of our own temporaries. The name grammar is re-proved and the
// entry must be a regular owned file opened without following links.
async function discardTemp(entry) {
  if (!entry) return;
  await entry.handle.close().catch(() => {});
  const leaf = PATH_BASENAME(entry.path);
  if (!capturedTest(PRIVATE_TEMP_NAME_PATTERN, leaf)) return;
  let handle;
  try {
    handle = await open(entry.path, FILE_READ_FLAGS);
  } catch {
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const uid = ownerUid();
    if (uid !== undefined && Number(stat.uid) !== uid) return;
  } finally {
    await handle.close().catch(() => {});
  }
  await unlink(entry.path).catch(() => {});
}

async function exclusiveLink(tempPath, targetPath) {
  try {
    await link(tempPath, targetPath);
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    if (error?.code === 'ELOOP') {
      failStore('artifact_entry_unsafe', 'artifact_ref.relative_path',
        'The artifact destination is a symbolic link and was not followed.');
    }
    failStore('artifact_stream_failed', 'artifact_ref.relative_path',
      'The artifact could not be published exclusively.');
  }
  return true;
}

// Roll back our own just-linked content, but only when the platform proves
// the entry under the public name is exactly the inode we published.
async function rollbackOwnLink(targetPath, tempStat) {
  let handle;
  try {
    handle = await open(targetPath, FILE_READ_FLAGS);
  } catch {
    return false;
  }
  let ours = false;
  try {
    const stat = await handle.stat();
    if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, tempStat)) ours = true;
  } finally {
    await handle.close().catch(() => {});
  }
  if (ours) await unlink(targetPath).catch(() => {});
  return ours;
}

// ---- Streaming ingest with the class cap enforced before any write. ----------

async function ingestSource(handle, classified, cap, declaredLength) {
  const hash = CREATE_HASH('sha256');
  let received = 0;
  if (classified.kind === 'bytes') {
    const view = classified.value;
    if (view.byteLength > cap) {
      failStore('artifact_stream_over_cap', 'source',
        `The artifact bytes exceed the ${cap}-byte class cap; nothing was published.`);
    }
    await writeChunk(handle, view);
    received = view.byteLength;
    if (received > 0) hash.update(view);
  } else {
    try {
      for await (const chunk of classified.value) {
        if (!isIntrinsicBinaryView(chunk)) {
          failStore('artifact_stream_invalid_chunk', 'source',
            'Every stream chunk must be an intrinsic Buffer/Uint8Array view.');
        }
        const size = chunk.byteLength;
        if (size > cap - received) {
          failStore('artifact_stream_over_cap', 'source',
            `The artifact stream exceeded the ${cap}-byte class cap; nothing beyond the cap was published.`);
        }
        if (received + size > declaredLength) {
          failStore('artifact_length_mismatch', 'source',
            'The artifact stream grew past its declared byte length; publication is refused.');
        }
        await writeChunk(handle, chunk);
        if (size > 0) hash.update(chunk);
        received += size;
      }
    } catch (error) {
      // Typed denials already carry their own content-free verdict; anything
      // else the iterable throws is swallowed into one typed denial so no
      // caller-supplied message, stack, or host detail ever escapes.
      if (error instanceof RunContractV1Error) throw error;
      failStore('artifact_stream_failed', 'source',
        'The artifact stream failed before its declared length; nothing was published.');
    }
  }
  return { received, digest: hash.digest('hex') };
}

// ---- Sidecar build and strict parse. -----------------------------------------

function buildMetaBytes(snapshot, byteLength, sha256Hex) {
  const document = {
    schema: ARTIFACT_STORE_SCHEMA_ID,
    artifact_ref: snapshot,
    byte_length: byteLength,
    sha256: sha256Hex,
  };
  const bytes = BUFFER_FROM(`${canonicalJsonStringify(document)}\n`, 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_STORE_META_BYTES) {
    failStore('artifact_metadata_malformed', 'meta', 'The sidecar document exceeds its bounded size.');
  }
  return bytes;
}

function assertNoDuplicateJsonKeys(text, field) {
  const scopes = [{ object: true, keys: new SET_CTOR() }];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        inString = false;
        const scope = scopes[scopes.length - 1];
        if (scope.object) {
          let cursor = index + 1;
          while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\n'
            || text[cursor] === '\r' || text[cursor] === '\t')) cursor += 1;
          if (text[cursor] === ':') {
            let key;
            try {
              key = JSON_PARSE(text.slice(stringStart - 1, index + 1));
            } catch {
              failStore('artifact_metadata_malformed', field, 'Sidecar JSON carries an invalid key.');
            }
            if (scope.keys.has(key)) {
              failStore('artifact_metadata_malformed', field,
                'Sidecar documents must not contain duplicate keys.');
            }
            scope.keys.add(key);
          }
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      stringStart = index + 1;
      continue;
    }
    if (char === '{') {
      scopes.push({ object: true, keys: new SET_CTOR() });
      if (scopes.length > 40) {
        failStore('artifact_metadata_malformed', field, 'Sidecar JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '[') {
      scopes.push({ object: false, keys: new SET_CTOR() });
      if (scopes.length > 40) {
        failStore('artifact_metadata_malformed', field, 'Sidecar JSON exceeds the nesting bound.');
      }
      continue;
    }
    if (char === '}' || char === ']') {
      scopes.pop();
      if (scopes.length === 0) {
        failStore('artifact_metadata_malformed', field, 'Sidecar JSON is unbalanced.');
      }
    }
  }
  if (inString || scopes.length !== 1) {
    failStore('artifact_metadata_malformed', field, 'Sidecar JSON is incomplete.');
  }
}

function decodeUtf8(bytes, field) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failStore('artifact_metadata_malformed', field, 'Sidecar documents must not begin with a UTF-8 BOM.');
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    failStore('artifact_metadata_malformed', field, 'Sidecar documents must be valid UTF-8.');
  }
}

// Strictly parse one sidecar and prove it describes exactly the claimed
// reference at exactly the claimed location. Any deviation is malformed or
// foreign; nothing about the hostile document is echoed back.
function parseMetaDocument(bytes, expectedClass, expectedRelativePath, field) {
  if (!BUFFER_IS_BUFFER(bytes) || bytes.byteLength === 0) {
    failStore('artifact_metadata_malformed', field, 'The sidecar document is missing or empty.');
  }
  if (bytes.byteLength > MAX_ARTIFACT_STORE_META_BYTES) {
    failStore('artifact_metadata_malformed', field, 'The sidecar document exceeds its bounded size.');
  }
  const text = decodeUtf8(bytes, field);
  assertNoDuplicateJsonKeys(text, field);
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    failStore('artifact_metadata_malformed', field, 'The sidecar document is not valid JSON.');
  }
  assertPlainObject(parsed, 'artifact_metadata_malformed', field, 'The sidecar document');
  assertDirectJsonClosure(parsed, field);
  const keys = sortedCapturedKeys(parsed);
  if (keys.length !== META_KEYS.length) {
    failStore('artifact_metadata_malformed', field, 'The sidecar document carries unexpected keys.');
  }
  for (let index = 0; index < META_KEYS.length; index += 1) {
    if (!capturedIncludes(keys, META_KEYS[index])) {
      failStore('artifact_metadata_malformed', field, 'The sidecar document carries unexpected keys.');
    }
  }
  if (parsed.schema !== ARTIFACT_STORE_SCHEMA_ID) {
    failStore('artifact_metadata_malformed', `${field}.schema`,
      `The sidecar schema must be exactly "${ARTIFACT_STORE_SCHEMA_ID}".`);
  }
  const snapshot = parseArtifactRefV1(parsed.artifact_ref, `${field}.artifact_ref`);
  const byteLength = parsed.byte_length;
  if (typeof byteLength !== 'number' || !NUMBER_IS_SAFE_INTEGER(byteLength)
    || byteLength < MIN_ARTIFACT_BYTE_LENGTH) {
    failStore('artifact_metadata_malformed', `${field}.byte_length`,
      'The sidecar byte length must be a positive integer.');
  }
  if (byteLength !== snapshot.byte_length) {
    failStore('artifact_metadata_malformed', `${field}.byte_length`,
      'The sidecar byte length disagrees with its bound reference.');
  }
  if (typeof parsed.sha256 !== 'string' || !capturedTest(PRIVATE_SHA256_PATTERN, parsed.sha256)) {
    failStore('artifact_metadata_malformed', `${field}.sha256`,
      'The sidecar digest must be a 64-character lowercase hex SHA-256.');
  }
  if (parsed.sha256 !== snapshot.sha256) {
    failStore('artifact_metadata_malformed', `${field}.sha256`,
      'The sidecar digest disagrees with its bound reference.');
  }
  if (snapshot.artifact_class !== expectedClass || snapshot.relative_path !== expectedRelativePath) {
    failStore('artifact_foreign_entry', field,
      'The sidecar describes a different artifact than its location names.');
  }
  return snapshot;
}

function canonicalSnapshotText(snapshot) {
  return canonicalJsonStringify(snapshot);
}

function digestsMatch(leftHex, rightHex) {
  if (typeof leftHex !== 'string' || typeof rightHex !== 'string') return false;
  if (leftHex.length !== 64 || rightHex.length !== 64) return false;
  return TIMING_SAFE_EQUAL(BUFFER_FROM(leftHex, 'hex'), BUFFER_FROM(rightHex, 'hex')) === true;
}

// ---- Bounded reads of stored artifacts. ---------------------------------------

async function openStoredFile(targetPath) {
  try {
    return await open(targetPath, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failStore('artifact_entry_unsafe', 'content',
        'The stored artifact location is not a regular non-symlink file.');
    }
    failStore('artifact_entry_unsafe', 'content', 'The stored artifact could not be opened safely.');
  }
}

async function readBoundedFile(targetPath, maxBytes, field) {
  const handle = await openStoredFile(targetPath);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) > maxBytes) {
      failStore('artifact_metadata_malformed', field, 'The stored document exceeds its bounded size.');
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      failStore('artifact_metadata_malformed', field, 'The stored document exceeds its bounded size.');
    }
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)) {
      failStore('artifact_torn_publication', field, 'The stored document changed while it was read.');
    }
    return { bytes, stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Open one published content file with full regular-file discipline and its
// class cap applied to the observed size. The caller owns closing the handle.
async function openPublishedContent(targetPath, cap) {
  const handle = await openStoredFile(targetPath);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, 'content');
    const size = Number(stat.size);
    if (!NUMBER_IS_SAFE_INTEGER(size) || size > cap) {
      failStore('artifact_entry_unsafe', 'content',
        `Stored content must not exceed the ${cap}-byte class cap.`);
    }
    return { handle, size };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Stream content only to recompute its length and digest. Bytes are never
// returned, buffered whole, or echoed.
async function measureStoredContent(handle, cap) {
  const hash = CREATE_HASH('sha256');
  let received = 0;
  const chunk = BUFFER_ALLOC(ARTIFACT_STORE_INGEST_CHUNK_BYTES);
  while (true) {
    let read;
    try {
      read = await handle.read(chunk, 0, chunk.byteLength, null);
    } catch {
      failStore('artifact_entry_unsafe', 'content', 'Stored artifact bytes could not be read safely.');
    }
    if (read.bytesRead === 0) break;
    received += read.bytesRead;
    if (received > cap) {
      failStore('artifact_entry_unsafe', 'content',
        `Stored content exceeds the ${cap}-byte class cap.`);
    }
    hash.update(chunk.subarray(0, read.bytesRead));
  }
  return { received, digest: hash.digest('hex') };
}

async function measurePublishedContent(targetPath, snapshot) {
  const cap = maxByteLengthForClass(snapshot.artifact_class);
  const opened = await openPublishedContent(targetPath, cap);
  if (opened === null) {
    failStore('artifact_torn_publication', 'content',
      'A sidecar exists without content; the publication is torn.');
  }
  try {
    const measured = await measureStoredContent(opened.handle, cap);
    if (measured.received !== snapshot.byte_length || measured.received !== opened.size) {
      failStore('artifact_length_mismatch', 'content',
        'Stored content length does not match the declared byte length.');
    }
    if (!digestsMatch(measured.digest, snapshot.sha256)) {
      failStore('artifact_digest_mismatch', 'content',
        'Stored content does not hash to the declared SHA-256 digest.');
    }
    return measured;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

// Verify one stored location end-to-end against one validated reference:
// sidecar presence, strict shape, exact stored-vs-requested snapshot
// equality, regular-file discipline, and streaming length/digest agreement
// against the stored sidecar claims (never the caller view).
async function verifyLocation(rootPath, snapshot) {
  const locations = namespaceLocations(rootPath, snapshot.artifact_class, snapshot.relative_path);
  const metaOpened = await readBoundedFile(locations.metaTarget, MAX_ARTIFACT_STORE_META_BYTES, 'meta');
  if (metaOpened === null) {
    const probe = await openStoredFile(locations.contentTarget);
    if (probe !== null) {
      await probe.close().catch(() => {});
      failStore('artifact_torn_publication', 'content',
        'Content exists without its sidecar; the publication is torn.');
    }
    failStore('artifact_not_found', 'artifact_ref', 'No stored artifact exists for that reference.');
  }
  const storedSnapshot = parseMetaDocument(metaOpened.bytes, snapshot.artifact_class,
    snapshot.relative_path, 'meta');
  if (canonicalSnapshotText(storedSnapshot) !== canonicalSnapshotText(snapshot)) {
    failStore(classifyExistingConflict(storedSnapshot, snapshot), 'artifact_ref',
      'A different artifact already occupies this location.');
  }
  await measurePublishedContent(locations.contentTarget, storedSnapshot);
  return locations;
}

// ---- Bounded enumeration for audit. --------------------------------------------

async function listDirectoryEntries(directory, field) {
  let dir;
  try {
    dir = await opendir(directory, { bufferSize: 16 });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
      failStore('artifact_parent_unsafe', field, 'A store tree is not a real directory.');
    }
    failStore('artifact_parent_unsafe', field, 'A store directory could not be enumerated.');
  }
  const names = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES) {
        failStore('artifact_inventory_exceeded', field,
          `Store directories must not exceed ${MAX_ARTIFACT_STORE_DIRECTORY_ENTRIES} entries.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      names.push(entry.name);
    }
  } finally {
    await dir.close().catch(() => {});
  }
  names.sort(compareStrings);
  return names;
}

function assertLegalEntryName(name, field) {
  if (capturedTest(PRIVATE_TEMP_NAME_PATTERN, name)) {
    failStore('artifact_torn_temporary', field,
      'A leftover temporary file is not authoritative and is not followed.');
  }
  try {
    validateArtifactRelativePathV1(name, field);
  } catch {
    failStore('artifact_foreign_entry', field,
      'A store entry name is not a legal artifact path segment.');
  }
}

// Depth-first bounded sweep of one tree. Returns the sorted relative paths of
// every regular-file leaf, condemning symlinks, special files, hardlinks,
// reserved temporaries, foreign names, and bound overruns along the way.
async function sweepTree(treeRoot, field, accounting) {
  const found = [];
  const walk = async (dir, prefix, depth) => {
    if (depth > ARTIFACT_STORE_MAX_DEPTH) {
      failStore('artifact_inventory_exceeded', field,
        `Store trees must not exceed ${ARTIFACT_STORE_MAX_DEPTH} levels of nesting.`);
    }
    const names = await listDirectoryEntries(dir, field);
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      assertLegalEntryName(name, field);
      const child = PATH_JOIN(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stat = await lstat(child).catch(() => undefined);
      if (stat === undefined) {
        failStore('artifact_entry_unsafe', field, 'A store entry vanished while it was audited.');
      }
      if (stat.isSymbolicLink()) {
        failStore('artifact_entry_unsafe', field, 'Store trees must not contain symbolic links.');
      }
      if (stat.isDirectory()) {
        await walk(child, relative, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        failStore('artifact_entry_unsafe', field,
          'Store trees must contain only regular files and real directories.');
      }
      assertRegularUnsharedFile(stat, field);
      accounting.files += 1;
      if (accounting.files > MAX_ARTIFACT_STORE_AUDIT_FILES) {
        failStore('artifact_inventory_exceeded', field,
          `A namespace must not exceed ${MAX_ARTIFACT_STORE_AUDIT_FILES} stored files.`);
      }
      validateArtifactRelativePathV1(relative, field);
      found.push(relative);
    }
  };
  await walk(treeRoot, '', 0);
  found.sort(compareStrings);
  return found;
}

// ---- Inventory fingerprint ------------------------------------------------------

function inventoryDigestOf(entries) {
  const hash = CREATE_HASH('sha256');
  const frame = (bytes) => {
    const prefix = BUFFER_ALLOC(4);
    prefix.writeUInt32BE(bytes.length, 0);
    hash.update(prefix);
    hash.update(bytes);
  };
  frame(BUFFER_FROM(ARTIFACT_DIGEST_DOMAIN, 'utf8'));
  const version = BUFFER_ALLOC(4);
  version.writeUInt32BE(ARTIFACT_DIGEST_VERSION, 0);
  hash.update(version);
  frame(BUFFER_FROM(ARTIFACT_STORE_INVENTORY_LABEL, 'utf8'));
  const count = BUFFER_ALLOC(8);
  WRITE_BIGUINT64_BE.call(count, BigInt(entries.length), 0);
  hash.update(count);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    frame(BUFFER_FROM(entry.artifact_class, 'utf8'));
    frame(BUFFER_FROM(entry.relative_path, 'utf8'));
    const length = BUFFER_ALLOC(8);
    WRITE_BIGUINT64_BE.call(length, BigInt(entry.byte_length), 0);
    hash.update(length);
    frame(BUFFER_FROM(entry.sha256, 'utf8'));
  }
  return hash.digest('hex');
}

// ---- Structural audit (no content streaming). ------------------------------------

// Prove the whole tree shape: only the two class namespaces exist; each holds
// only real private content/meta directories; every entry name is a legal
// segment; every leaf is a regular unshared owner-only file; content and
// sidecars pair up exactly; and every sidecar strictly re-parses to the
// reference its location names, with matching content size.
async function structuralAudit(rootPath) {
  const perNamespace = capturedCreate(null);
  const entries = [];
  for (let index = 0; index < ARTIFACT_CLASSES.length; index += 1) {
    const artifactClass = ARTIFACT_CLASSES[index];
    const field = artifactClass;
    const classDir = PATH_JOIN(rootPath, artifactClass);
    const classStat = await lstat(classDir).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      failStore('artifact_parent_unsafe', field, 'A store namespace could not be inspected.');
    });
    if (classStat === undefined) {
      perNamespace[artifactClass] = { artifacts: 0, bytes: 0 };
      continue;
    }
    assertPrivateDirectory(classStat, field, 'namespace');
    const names = await listDirectoryEntries(classDir, field);
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex];
      if (name !== ARTIFACT_STORE_CONTENT_DIR && name !== ARTIFACT_STORE_META_DIR) {
        if (capturedTest(PRIVATE_TEMP_NAME_PATTERN, name)) {
          failStore('artifact_torn_temporary', field,
            'A leftover temporary file is not authoritative and is not followed.');
        }
        failStore('artifact_foreign_entry', field, 'A store namespace contains a foreign entry.');
      }
      const childStat = await lstat(PATH_JOIN(classDir, name)).catch(() => undefined);
      if (childStat === undefined) {
        failStore('artifact_parent_unsafe', field, 'A store namespace entry vanished while it was audited.');
      }
      assertPrivateDirectory(childStat, field, `namespace ${name}`);
    }
    const contentDir = PATH_JOIN(classDir, ARTIFACT_STORE_CONTENT_DIR);
    const metaDir = PATH_JOIN(classDir, ARTIFACT_STORE_META_DIR);
    const accounting = { files: 0 };
    const contentPaths = await lstat(contentDir).then(
      () => sweepTree(contentDir, `${field}.content`, accounting),
      (error) => {
        if (error?.code === 'ENOENT') return [];
        failStore('artifact_parent_unsafe', `${field}.content`, 'A content tree could not be inspected.');
      },
    );
    const metaPaths = await lstat(metaDir).then(
      () => sweepTree(metaDir, `${field}.meta`, accounting),
      (error) => {
        if (error?.code === 'ENOENT') return [];
        failStore('artifact_parent_unsafe', `${field}.meta`, 'A sidecar tree could not be inspected.');
      },
    );
    const contentSet = new SET_CTOR(contentPaths);
    const metaSet = new SET_CTOR();
    for (let metaIndex = 0; metaIndex < metaPaths.length; metaIndex += 1) {
      const stripped = metaPaths[metaIndex].replace(/\.json$/u, '');
      validateArtifactRelativePathV1(stripped, `${field}.meta`);
      metaSet.add(stripped);
    }
    if (contentPaths.length !== contentSet.size || metaPaths.length !== metaSet.size) {
      failStore('artifact_foreign_entry', field,
        'Two sidecars or two content files claim one artifact location.');
    }
    for (let contentIndex = 0; contentIndex < contentPaths.length; contentIndex += 1) {
      if (!metaSet.has(contentPaths[contentIndex])) {
        failStore('artifact_torn_publication', `${field}.content`,
          'Content exists without its sidecar; the publication is torn.');
      }
    }
    for (const stripped of metaSet) {
      if (!contentSet.has(stripped)) {
        failStore('artifact_torn_publication', `${field}.meta`,
          'A sidecar exists without content; the publication is torn.');
      }
    }
    let namespaceBytes = 0;
    for (let contentIndex = 0; contentIndex < contentPaths.length; contentIndex += 1) {
      const relative = contentPaths[contentIndex];
      const locations = namespaceLocations(rootPath, artifactClass, relative);
      const metaOpened = await readBoundedFile(locations.metaTarget, MAX_ARTIFACT_STORE_META_BYTES,
        `${field}.meta`);
      if (metaOpened === null) {
        failStore('artifact_torn_publication', `${field}.meta`,
          'A sidecar disappeared while the store was audited.');
      }
      const snapshot = parseMetaDocument(metaOpened.bytes, artifactClass, relative, `${field}.meta`);
      const stat = await lstat(locations.contentTarget).catch(() => undefined);
      if (stat === undefined) {
        failStore('artifact_torn_publication', `${field}.content`,
          'Content disappeared while the store was audited.');
      }
      assertRegularUnsharedFile(stat, `${field}.content`);
      const size = Number(stat.size);
      if (size !== snapshot.byte_length || size > maxByteLengthForClass(artifactClass)) {
        failStore('artifact_entry_unsafe', `${field}.content`,
          'Stored content size disagrees with its sidecar or exceeds the class cap.');
      }
      namespaceBytes += size;
      entries.push({
        artifact_class: artifactClass,
        relative_path: relative,
        byte_length: snapshot.byte_length,
        sha256: snapshot.sha256,
      });
    }
    perNamespace[artifactClass] = { artifacts: contentPaths.length, bytes: namespaceBytes };
  }
  entries.sort((left, right) => compareStrings(left.artifact_class, right.artifact_class)
    || compareStrings(left.relative_path, right.relative_path));
  return { perNamespace, entries };
}

// ---- Publication -----------------------------------------------------------------

// Read and fully re-verify whatever authoritative state already occupies this
// location. Refuses torn states instead of healing them.
async function readExistingState(locations, snapshot) {
  const metaOpened = await readBoundedFile(locations.metaTarget, MAX_ARTIFACT_STORE_META_BYTES, 'meta');
  if (metaOpened === null) {
    failStore('artifact_torn_publication', 'meta',
      'Content exists without its sidecar; the store is torn and publication is refused.');
  }
  const existingSnapshot = parseMetaDocument(metaOpened.bytes, snapshot.artifact_class,
    snapshot.relative_path, 'meta');
  const measured = await measurePublishedContent(locations.contentTarget, existingSnapshot);
  return { existingSnapshot, measured };
}

function classifyExistingConflict(existingSnapshot, snapshot) {
  if (existingSnapshot.byte_length === snapshot.byte_length
    && digestsMatch(existingSnapshot.sha256, snapshot.sha256)) {
    return 'artifact_metadata_conflict';
  }
  return 'artifact_content_conflict';
}

async function publishPrepared(root, snapshot, source) {
  const locations = namespaceLocations(root.path, snapshot.artifact_class, snapshot.relative_path);
  const cap = maxByteLengthForClass(snapshot.artifact_class);
  for (let index = 0; index < locations.segments.length; index += 1) {
    const segment = locations.segments[index];
    if (capturedTest(PRIVATE_TEMP_NAME_PATTERN, segment)
      || capturedTest(PRIVATE_TEMP_NAME_PATTERN, `${segment}${ARTIFACT_STORE_META_SUFFIX}`)) {
      failStore('artifact_reserved_name_denied', 'artifact_ref.relative_path',
        'An artifact path may not spell the reserved temporary-name grammar.');
    }
  }

  const captures = [];
  await ensurePrivateDirectory(PATH_JOIN(root.path, snapshot.artifact_class), captures);
  await ensureParentChain(locations.contentBase, locations.segments.slice(0, -1), captures);
  await ensureParentChain(locations.metaBase, locations.segments.slice(0, -1), captures);

  // A pre-existing sidecar decides first: identical means this exact
  // publication already completed; anything else conflicts before we touch
  // content at all.
  const preexistingMeta = await readBoundedFile(locations.metaTarget, MAX_ARTIFACT_STORE_META_BYTES,
    'meta');
  if (preexistingMeta !== null) {
    const existingSnapshot = parseMetaDocument(preexistingMeta.bytes, snapshot.artifact_class,
      snapshot.relative_path, 'meta');
    if (canonicalSnapshotText(existingSnapshot) !== canonicalSnapshotText(snapshot)) {
      failStore(classifyExistingConflict(existingSnapshot, snapshot), 'artifact_ref',
        'A different artifact already occupies this location.');
    }
    await readExistingState(locations, snapshot);
    await assertChainUnchanged(captures);
    return receiptFor(snapshot, { created: false, byteLength: snapshot.byte_length,
      sha256: snapshot.sha256 });
  }

  // Ingest into a private unpredictable same-directory temporary with the
  // class cap enforced before each chunk is written.
  const contentTemp = await createPrivateTemp(PATH_DIRNAME(locations.contentTarget));
  let metaTemp;
  try {
    const classified = classifySource(source);
    const ingested = await ingestSource(contentTemp.handle, classified, cap, snapshot.byte_length);
    if (ingested.received !== snapshot.byte_length) {
      failStore('artifact_length_mismatch', 'artifact_ref.byte_length',
        'Actual artifact length does not match the declared byte length; nothing was published.');
    }
    if (!digestsMatch(ingested.digest, snapshot.sha256)) {
      failStore('artifact_digest_mismatch', 'artifact_ref.sha256',
        'Actual artifact bytes do not hash to the declared SHA-256; nothing was published.');
    }
    try {
      await contentTemp.handle.sync();
    } catch {
      failStore('artifact_stream_failed', 'temporary',
        'The temporary artifact could not be synchronized.');
    }
    let tempStat;
    try {
      tempStat = await lstat(contentTemp.path);
    } catch {
      failStore('artifact_stream_failed', 'temporary',
        'The temporary artifact disappeared before publication.');
    }
    assertRegularUnsharedFile(tempStat, 'temporary');
    if (Number(tempStat.size) !== ingested.received) {
      failStore('artifact_stream_failed', 'temporary', 'The temporary write was truncated.');
    }

    const metaBytes = buildMetaBytes(snapshot, ingested.received, ingested.digest);
    metaTemp = await createPrivateTemp(PATH_DIRNAME(locations.metaTarget));
    await writeChunk(metaTemp.handle, metaBytes);
    await metaTemp.handle.sync();
    await metaTemp.handle.close().catch(() => {});

    const linked = await exclusiveLink(contentTemp.path, locations.contentTarget);
    if (!linked) {
      // Competing publication: verify the winner instead of overwriting.
      const state = await readExistingState(locations, snapshot);
      if (canonicalSnapshotText(state.existingSnapshot) !== canonicalSnapshotText(snapshot)) {
        failStore(classifyExistingConflict(state.existingSnapshot, snapshot), 'artifact_ref',
          'A different artifact already occupies this location.');
      }
      await assertChainUnchanged(captures);
      return receiptFor(snapshot, { created: false, byteLength: snapshot.byte_length,
        sha256: snapshot.sha256 });
    }

    const linkedMeta = await exclusiveLink(metaTemp.path, locations.metaTarget);
    if (!linkedMeta) {
      const racedMeta = await readBoundedFile(locations.metaTarget, MAX_ARTIFACT_STORE_META_BYTES,
        'meta');
      const racedSnapshot = racedMeta === null
        ? null
        : parseMetaDocument(racedMeta.bytes, snapshot.artifact_class, snapshot.relative_path, 'meta');
      const identical = racedSnapshot !== null
        && canonicalSnapshotText(racedSnapshot) === canonicalSnapshotText(snapshot);
      if (!identical) {
        // Different reference: undo our content link so no authoritative file
        // is left without its matching sidecar. The unlink happens only when
        // the platform proves the inode is ours.
        await rollbackOwnLink(locations.contentTarget, tempStat);
        failStore(classifyExistingConflict(racedSnapshot, snapshot), 'artifact_ref',
          'A different artifact already occupies this location.');
      }
      // Identical reference: keep our just-linked content; together with the
      // observed sidecar it completes exactly the publication the winner
      // already recorded.
      await assertChainUnchanged(captures);
      return receiptFor(snapshot, { created: false, byteLength: snapshot.byte_length,
        sha256: snapshot.sha256 });
    }

    await discardTemp(contentTemp);
    await discardTemp(metaTemp);
    await syncDirectoryOf(locations.contentTarget);
    await syncDirectoryOf(locations.metaTarget);
    await assertChainUnchanged(captures);
    await provePublication(locations, tempStat);
    return receiptFor(snapshot, { created: true, byteLength: ingested.received,
      sha256: ingested.digest, tempStat });
  } finally {
    await discardTemp(contentTemp);
    await discardTemp(metaTemp);
  }
}

function receiptFor(snapshot, facts) {
  return freezeData({
    schema: ARTIFACT_STORE_SCHEMA_ID,
    artifact_ref: snapshot,
    namespace: snapshot.artifact_class,
    byte_length: facts.byteLength,
    sha256: facts.sha256,
    ref_digest: artifactRefDigestV1(snapshot, 'artifact_ref').digest,
    created: facts.created,
  });
}

// Re-prove a fresh publication: both public names must still resolve, without
// following links, to exactly the inodes we wrote.
async function provePublication(locations, contentTempStat) {
  const contentHandle = await openStoredFile(locations.contentTarget);
  if (contentHandle === null) {
    failStore('artifact_torn_publication', 'content', 'The published content could not be re-opened.');
  }
  try {
    const stat = await contentHandle.stat();
    assertRegularUnsharedFile(stat, 'content');
    if (!sameIdentity(stat, contentTempStat)) {
      failStore('artifact_parent_swapped', 'content',
        'The published artifact no longer resolves to the published inode.');
    }
  } finally {
    await contentHandle.close().catch(() => {});
  }
  const metaHandle = await openStoredFile(locations.metaTarget);
  if (metaHandle === null) {
    failStore('artifact_torn_publication', 'meta', 'The published sidecar could not be re-opened.');
  } else {
    await metaHandle.close().catch(() => {});
  }
}

// ---- Public API -----------------------------------------------------------------

function withStoreChain(token, operation) {
  const id = `${STRING(token.dev)}:${STRING(token.ino)}`;
  const previous = STORE_CHAINS.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).then(() => {
    if (STORE_CHAINS.get(id) === settled) STORE_CHAINS.delete(id);
  });
  STORE_CHAINS.set(id, settled);
  return current;
}

// One serialized, structurally audited operation. The root is reopened
// without following links, proven identical to the token, and bracketed
// around the whole body, so every operation observes a structurally sound
// store or fails closed before acting.
async function operate(token, fn) {
  return withStoreChain(token, async () => {
    const root = await reopenRoot(token);
    try {
      await structuralAudit(root.path);
      return await fn(root);
    } finally {
      await root.handle.close().catch(() => {});
    }
  });
}

function assertStoreHandle(store) {
  assertPlainObject(store, 'invalid_type', 'store', 'The artifact store handle');
  if (store.schema !== ARTIFACT_STORE_SCHEMA_ID || typeof store.internalOperate !== 'function') {
    failStore('invalid_type', 'store', 'The artifact store handle was not produced by this module.');
  }
  return store;
}

export async function openArtifactStoreV1(input) {
  assertPlainObject(input, 'invalid_type', 'options', 'The artifact store options');
  assertDirectJsonClosure(input, 'options');
  const keys = sortedCapturedKeys(input);
  if (keys.length !== 1 || keys[0] !== 'root') {
    failStore('unknown_key', 'options', 'Artifact store options accept exactly one key: root.');
  }
  const resolved = assertSafeRootPath(input.root);
  const opened = await openRootHandle(resolved);
  try {
    await structuralAudit(opened.path);
    const token = capturedFreeze({ path: opened.path, dev: opened.dev, ino: opened.ino });
    return capturedFreeze({
      schema: ARTIFACT_STORE_SCHEMA_ID,
      root: token.path,
      namespaces: ARTIFACT_STORE_NAMESPACES,
      internalOperate: (fn) => operate(token, fn),
      async publish(ref, source) {
        return publishArtifactV1(this, ref, source);
      },
      async verifyArtifact(ref) {
        return verifyStoredArtifactV1(this, ref);
      },
      async verifyArtifacts(refs) {
        return verifyStoredArtifactsV1(this, refs);
      },
      async audit() {
        return auditArtifactStoreV1(this);
      },
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function publishArtifactV1(store, refInput, source) {
  const handle = assertStoreHandle(store);
  const snapshot = parseArtifactRefV1(refInput, 'artifact_ref');
  classifySource(source);
  return handle.internalOperate((root) => publishPrepared(root, snapshot, source));
}

export async function verifyStoredArtifactV1(store, refInput) {
  const handle = assertStoreHandle(store);
  const snapshot = parseArtifactRefV1(refInput, 'artifact_ref');
  return handle.internalOperate(async (root) => {
    await verifyLocation(root.path, snapshot);
    return freezeData({
      schema: ARTIFACT_STORE_SCHEMA_ID,
      artifact_ref: snapshot,
      namespace: snapshot.artifact_class,
      byte_length: snapshot.byte_length,
      sha256: snapshot.sha256,
      verified: true,
    });
  });
}

export async function verifyStoredArtifactsV1(store, refInputs) {
  const handle = assertStoreHandle(store);
  const ordered = orderArtifactRefsV1(refInputs, 'artifact_refs');
  const verdicts = [];
  for (let index = 0; index < ordered.length; index += 1) {
    verdicts.push(await verifyStoredArtifactV1(handle, ordered[index]));
  }
  return freezeData(verdicts);
}

export async function auditArtifactStoreV1(store) {
  const handle = assertStoreHandle(store);
  return handle.internalOperate(async (root) => {
    const structural = await structuralAudit(root.path);
    const detailed = [];
    let auditedBytes = 0;
    for (let index = 0; index < structural.entries.length; index += 1) {
      const entry = structural.entries[index];
      const locations = namespaceLocations(root.path, entry.artifact_class, entry.relative_path);
      const measured = await measurePublishedContent(locations.contentTarget, {
        artifact_class: entry.artifact_class,
        byte_length: entry.byte_length,
        sha256: entry.sha256,
      });
      auditedBytes += measured.received;
      if (auditedBytes > MAX_ARTIFACT_STORE_AUDIT_BYTES) {
        failStore('artifact_inventory_exceeded', 'audit',
          `A single audit must not stream more than ${MAX_ARTIFACT_STORE_AUDIT_BYTES} bytes.`);
      }
      detailed.push(freezeData({
        artifact_class: entry.artifact_class,
        relative_path: entry.relative_path,
        byte_length: entry.byte_length,
        sha256: entry.sha256,
      }));
    }
    return freezeData({
      schema: ARTIFACT_STORE_SCHEMA_ID,
      artifacts: detailed.length,
      namespaces: freezeData({
        raw: freezeData({ ...structural.perNamespace.raw }),
        sanitized: freezeData({ ...structural.perNamespace.sanitized }),
      }),
      entries: freezeData(detailed),
      inventory_digest: inventoryDigestOf(structural.entries),
    });
  });
}

capturedFreeze(openArtifactStoreV1);
capturedFreeze(publishArtifactV1);
capturedFreeze(verifyStoredArtifactV1);
capturedFreeze(verifyStoredArtifactsV1);
capturedFreeze(auditArtifactStoreV1);
