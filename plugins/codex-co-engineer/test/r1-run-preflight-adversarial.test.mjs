// P26 run preflight — adversarial coverage: hostile callers (Proxies,
// accessors, symbols, non-enumerables, aliases, exotic prototypes), hostile
// seams (spawn handles, injected host facts), and the closed read-only git
// observation posture. Every failure must be a bounded content-free typed
// error raised without any launch-shaped action.

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

import {
  GIT_CLOSED_ENV,
  GIT_EXECUTABLE,
} from '../mcp/v3/git-identity.mjs';
import {
  RUN_PREFLIGHT_READONLY_GIT_COMMANDS,
  validateRunPreflightV1,
} from '../mcp/v3/run-preflight.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  createLinearRepo,
  hostFacts,
  twoLaneManifest,
} from './fixtures/r1-run-preflight-fixtures.mjs';

const SUFFICIENT_HOST = hostFacts();
const ISOLATION_PREFIX = [
  '--no-replace-objects',
  '--no-optional-locks',
  '--literal-pathspecs',
];

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected typed error, got ${error}`);
    assert.equal(error.code, code, error.message);
    assert.ok(Buffer.byteLength(error.message, 'utf8') <= 200);
    return error;
  }
  throw new Error(`expected failure with code ${code}`);
}

test('manifest Proxies are denied before any observation runs', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    let spawned = false;
    await expectCode(
      validateRunPreflightV1(
        { manifest: new Proxy(manifest, {}) },
        { host: SUFFICIENT_HOST, spawn: () => { spawned = true; } },
      ),
      'proxy_denied',
    );
    assert.equal(spawned, false);
  } finally {
    await repo.cleanup();
  }
});

test('symbol-keyed requests are denied without running getters', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const getter = () => { throw new Error('getter must never run'); };
    const request = { manifest };
    Object.defineProperty(request, Symbol('poison'), { get: getter, enumerable: true });
    await expectCode(validateRunPreflightV1(request, { host: SUFFICIENT_HOST }), 'symbol_key_denied');
  } finally {
    await repo.cleanup();
  }
});

test('non-enumerable manifest decorations fail closed', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    Object.defineProperty(manifest, 'hidden', {
      value: { poison: true },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    await expectCode(
      validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST }),
      'non_enumerable_property_denied',
    );
  } finally {
    await repo.cleanup();
  }
});

test('null-prototype manifests keep their accepted P02 semantics', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = Object.create(null);
    Object.assign(manifest, twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha }));
    const receipt = await validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST });
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.repository.path, repo.root);
  } finally {
    await repo.cleanup();
  }
});

test('aliased subtrees inside one request are denied', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const shared = { note: 'shared' };
    manifest.alpha_note = shared;
    manifest.beta_note = shared;
    const error = await expectCode(
      validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST }),
      'aliased_reference_denied',
    );
    void error;
  } finally {
    await repo.cleanup();
  }
});

test('undefined members are denied like ordinary JSON violations', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    manifest.extra = undefined;
    await expectCode(
      validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST }),
      'own_undefined_denied',
    );
  } finally {
    await repo.cleanup();
  }
});

test('unknown manifest keys keep the accepted upstream denial', async () => {
  const repo = await createLinearRepo();
  try {
    const foreign = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    foreign.totally_unknown = true;
    await expectCode(
      validateRunPreflightV1({ manifest: foreign }, { host: SUFFICIENT_HOST }),
      'unknown_key',
    );
  } finally {
    await repo.cleanup();
  }
});

test('the request key set is closed and the manifest is required', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    await expectCode(
      validateRunPreflightV1({ manifest, extra: true }, { host: SUFFICIENT_HOST }),
      'invalid_format',
    );
    await expectCode(validateRunPreflightV1({}, { host: SUFFICIENT_HOST }), 'missing_key');
  } finally {
    await repo.cleanup();
  }
});

test('hostile injected host facts fail closed', async () => {
  const repo = await createLinearRepo();
  try {
    const base = { repositoryPath: repo.root, baseSha: repo.baseSha };
    const cases = [
      ['negative', hostFacts({ cpu_parallelism: -1 }), 'host_facts_invalid'],
      ['fractional', hostFacts({ available_ram_bytes: 1.5 }), 'host_facts_invalid'],
      ['string', hostFacts({ total_ram_bytes: 'big' }), 'host_facts_invalid'],
      ['unsafe', hostFacts({ available_ram_bytes: Number.MAX_SAFE_INTEGER + 1 }), 'host_facts_invalid'],
      ['NaN', hostFacts({ cpu_parallelism: Number.NaN }), 'invalid_json_value'],
    ];
    for (const [label, facts, code] of cases) {
      const error = await expectCode(
        validateRunPreflightV1({ manifest: twoLaneManifest(base) }, { host: facts }),
        code,
      );
      if (code === 'host_facts_invalid') {
        assert.match(error.path, /^options\.host\./u, label);
      }
    }
    await expectCode(
      validateRunPreflightV1(
        { manifest: twoLaneManifest(base) },
        { host: hostFacts({ unexpected: 1 }) },
      ),
      'invalid_format',
    );
    await expectCode(
      validateRunPreflightV1({ manifest: twoLaneManifest(base) }, { host: new Proxy(hostFacts(), {}) }),
      'proxy_denied',
    );
  } finally {
    await repo.cleanup();
  }
});

test('hostile spawn seams fail closed before any observation runs', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    await expectCode(
      validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST, spawn: 'not-a-function' }),
      'invalid_type',
    );
    await expectCode(
      validateRunPreflightV1({ manifest }, { host: SUFFICIENT_HOST, spawn: new Proxy(() => {}, {}) }),
      'proxy_denied',
    );
  } finally {
    await repo.cleanup();
  }
});

test('a throwing injected spawn becomes one bounded infrastructure failure', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const error = await expectCode(
      validateRunPreflightV1(
        { manifest },
        { host: SUFFICIENT_HOST, spawn: () => { throw new Error('explosive'); } },
      ),
      'observation_failed',
    );
    assert.doesNotMatch(error.message, /explosive/u);
  } finally {
    await repo.cleanup();
  }
});

function fakeGitChild(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  queueMicrotask(() => script(child));
  return child;
}

test('oversized observation output hits the bound and kills the child', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const spawned = [];
    const error = await expectCode(
      validateRunPreflightV1({ manifest }, {
        host: SUFFICIENT_HOST,
        spawn(file, args) {
          spawned.push(args);
          if (args.includes('rev-parse')) {
            return fakeGitChild((child) => {
              child.stdout.emit('data', Buffer.alloc(8192, 0x61));
              child.emit('close', 0, null);
            });
          }
          throw new Error('should not be reached');
        },
      }),
      'bounds_exceeded',
    );
    assert.doesNotMatch(error.message, /616161/u);
    assert.equal(spawned.length, 1);
  } finally {
    await repo.cleanup();
  }
});

test('an erroring child process maps to one bounded infrastructure failure', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    await expectCode(
      validateRunPreflightV1({ manifest }, {
        host: SUFFICIENT_HOST,
        spawn() {
          return fakeGitChild((child) => {
            child.emit('error', new Error('spawn boom'));
          });
        },
      }),
      'observation_failed',
    );
  } finally {
    await repo.cleanup();
  }
});

test('every real observation keeps the closed argv, env, and cwd posture', async () => {
  const repo = await createLinearRepo();
  try {
    const manifest = twoLaneManifest({ repositoryPath: repo.root, baseSha: repo.baseSha });
    const records = [];
    const receipt = await validateRunPreflightV1({ manifest }, {
      host: SUFFICIENT_HOST,
      spawn(file, args, options) {
        records.push({ file, args, options });
        return nodeSpawn(file, args, options);
      },
    });
    assert.equal(receipt.status, 'ready');
    assert.ok(records.length >= 3);
    for (const record of records) {
      assert.equal(record.file, GIT_EXECUTABLE);
      assert.deepEqual(record.options.env, GIT_CLOSED_ENV);
      assert.equal(Object.isFrozen(record.options.env), true);
      assert.equal(record.options.cwd, '/');
      assert.deepEqual(record.args.slice(0, 3), ISOLATION_PREFIX);
      const dashC = record.args.indexOf('-C');
      assert.ok(dashC > 3, record.args.join(' '));
      assert.ok(
        RUN_PREFLIGHT_READONLY_GIT_COMMANDS.includes(record.args[dashC + 2]),
        record.args.join(' '),
      );
    }
  } finally {
    await repo.cleanup();
  }
});
