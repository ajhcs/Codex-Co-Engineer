import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');

const FINAL_DOCS = 'docs/assets/co-engineer-3.4.0/final';
const FINAL_PLUGIN = 'assets/experience/final';
const MANIFEST_RELATIVE = `${FINAL_DOCS}/manifest.json`;

const WORDMARK_SOURCE = Object.freeze({
  docs: `${FINAL_DOCS}/sources/grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png`,
  plugin: `plugins/codex-co-engineer/${FINAL_PLUGIN}/sources/grok-image-d7f8b7c9-c929-4a3f-96d0-35f69ffb1403.png`,
  sha256: 'fcd7e67237e8bac3d2dd5c7c21b37e61df4acefac01cd2172c25c80372e03bca',
  bytes: 1250372,
  width: 1792,
  height: 1008,
});

const SQUARE_SOURCE = Object.freeze({
  docs: `${FINAL_DOCS}/sources/chatgpt-image-aug-27-2026-square-mark.png`,
  plugin: `plugins/codex-co-engineer/${FINAL_PLUGIN}/sources/chatgpt-image-aug-27-2026-square-mark.png`,
  sha256: '6282ebb40e87fe0ef71069e1e2cd7603d05f21dfe0ad2623605194702f5180fa',
  bytes: 736141,
  width: 1254,
  height: 1254,
});

const WORDMARK_DERIVED = Object.freeze({
  docs: `${FINAL_DOCS}/derived/wordmark.png`,
  plugin: `plugins/codex-co-engineer/${FINAL_PLUGIN}/derived/wordmark.png`,
  sha256: '5f3f4e2c7dea674bc7e6f558a70ebecc78031c364f5821c3165c344e341561d5',
  bytes: 71971,
  width: 1024,
  height: 576,
});

const SQUARE_DERIVED = Object.freeze({
  docs: `${FINAL_DOCS}/derived/square-mark.png`,
  plugin: `plugins/codex-co-engineer/${FINAL_PLUGIN}/derived/square-mark.png`,
  sha256: '0c9e38a12d8b91c1d5f7823a6fa227a9759a90e9253b609a23410b6c65bd79eb',
  bytes: 155333,
  width: 512,
  height: 512,
});

const PUBLISHED_README_STILLS = Object.freeze({
  'hero-demo': `${FINAL_DOCS}/derived/hero-demo.jpg`,
  'first-delegation': `${FINAL_DOCS}/derived/first-delegation.jpg`,
  'provider-choices': `${FINAL_DOCS}/derived/provider-choices.jpg`,
  'failure-unresolved': `${FINAL_DOCS}/derived/failure-unresolved.jpg`,
  'install-auth': `${FINAL_DOCS}/derived/install-auth.jpg`,
});

const FROZEN_README_STATICS = Object.freeze({
  [`${FINAL_DOCS}/derived/hero-demo.jpg`]: {
    sha256: 'e266f0432fe70d2f48711a1c19628f7a9371fa23e46bf83824bc54844ded3edd',
    bytes: 86323,
    width: 1920,
    height: 1088,
  },
  [`${FINAL_DOCS}/derived/first-delegation.jpg`]: {
    sha256: 'd7e95ac17fb15e8e4a6001a2101a60c501c48d38dc4103c524b4da0c1b2ac17d',
    bytes: 66218,
    width: 1600,
    height: 1000,
  },
  [`${FINAL_DOCS}/derived/provider-choices.jpg`]: {
    sha256: '039400f467beaecab450dccdffea67b42260a076c5aa325707b1aa4fd644c638',
    bytes: 81520,
    width: 1600,
    height: 1000,
  },
  [`${FINAL_DOCS}/derived/failure-unresolved.jpg`]: {
    sha256: '874ab09c0e62f97c394e5edfc1d5f31e172447130fa0bb3a6854196f4ee7029d',
    bytes: 110589,
    width: 1600,
    height: 1000,
  },
  [`${FINAL_DOCS}/derived/install-auth.jpg`]: {
    sha256: '66619555d45ad54112a3d4968f5e69e05c0718501675af0300b57600a21e3157',
    bytes: 46657,
    width: 1600,
    height: 1000,
  },
});

const REJECTED_PUBLIC_PATHS = Object.freeze([
  `${FINAL_DOCS}/derived/hero-muted.mp4`,
  `${FINAL_DOCS}/derived/hero-muted.webm`,
  `${FINAL_DOCS}/derived/hero-frame-poster.jpg`,
  `${FINAL_DOCS}/derived/multi-lane-run.held.jpg`,
  `${FINAL_DOCS}/derived/multi-lane-frame-poster.held.jpg`,
  `${FINAL_DOCS}/derived/multi-lane-muted.held.mp4`,
  `${FINAL_DOCS}/derived/multi-lane-muted.held.webm`,
  'docs/assets/co-engineer-3.4.0/poster.jpg',
  'docs/assets/co-engineer-3.4.0/hero-muted.mp4',
  'docs/assets/co-engineer-3.4.0/hero-muted.webm',
  'docs/assets/co-engineer-3.4.0/mark.svg',
  'docs/assets/codex-co-engineer-3.1.0.jpg',
  'docs/assets/codex-co-engineer-3.1.0.svg',
  './assets/experience/poster.jpg',
  './assets/experience/hero-muted.mp4',
  './assets/experience/hero-muted.webm',
  './assets/experience/mark.svg',
  'plugins/codex-co-engineer/assets/experience/mark.svg',
]);

const OPTIONAL_SLOTS = Object.freeze(['multi-lane-run', 'grouped-attention', 'verified-final-decision']);
const FIVE_TOOLS = Object.freeze(['status', 'delegate', 'task', 'tasks', 'cancel']);
const SAFE_RELATIVE = /^[A-Za-z0-9./_-]+$/u;
const PNG_MAGIC = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], PNG_MAGIC);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('JPEG magic missing.');
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = (buffer[offset + 2] << 8) + buffer[offset + 3];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: (buffer[offset + 5] << 8) + buffer[offset + 6],
        width: (buffer[offset + 7] << 8) + buffer[offset + 8],
      };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG SOF marker missing.');
}

function collectMarkdownMedia(markdown) {
  const images = new Set();
  const alts = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/gu)) {
    const target = match[2].split('#', 1)[0];
    if (/^(?:https?:|#|mailto:)/iu.test(target)) continue;
    images.add(target);
    alts.push({ alt: match[1].trim(), target });
  }
  const links = new Set();
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const target = match[1].split('#', 1)[0];
    if (/^(?:https?:|#|mailto:)/iu.test(target)) continue;
    links.add(target);
  }
  return { images, links, alts };
}

function collectStrings(value, into = []) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, into));
  }
  return into;
}

function publicHaystacks(readme, plugin, marketplace) {
  return [readme, JSON.stringify(plugin), JSON.stringify(marketplace)];
}

async function assertExactAsset(relative, expected, kind) {
  const absolute = path.join(REPO, relative);
  const buffer = await readFile(absolute);
  const info = await stat(absolute);
  assert.equal(info.isFile(), true, relative);
  assert.equal(info.size, expected.bytes, relative);
  assert.equal(buffer.byteLength, expected.bytes, relative);
  assert.equal(sha256(buffer), expected.sha256, relative);
  const size = kind === 'png' ? pngSize(buffer) : jpegSize(buffer);
  assert.equal(size.width, expected.width, relative);
  assert.equal(size.height, expected.height, relative);
}

test('approved identity originals and derivatives keep exact hashes, dimensions, and bytes', async () => {
  for (const spec of [WORDMARK_SOURCE, SQUARE_SOURCE]) {
    await assertExactAsset(spec.docs, spec, 'png');
    await assertExactAsset(spec.plugin, spec, 'png');
  }
  for (const spec of [WORDMARK_DERIVED, SQUARE_DERIVED]) {
    await assertExactAsset(spec.docs, spec, 'png');
    await assertExactAsset(spec.plugin, spec, 'png');
  }
  const docsWordmark = await readFile(path.join(REPO, WORDMARK_DERIVED.docs));
  const pluginWordmark = await readFile(path.join(REPO, WORDMARK_DERIVED.plugin));
  const docsSquare = await readFile(path.join(REPO, SQUARE_DERIVED.docs));
  const pluginSquare = await readFile(path.join(REPO, SQUARE_DERIVED.plugin));
  assert.deepEqual(docsWordmark, pluginWordmark);
  assert.deepEqual(docsSquare, pluginSquare);
  assert.notEqual(WORDMARK_SOURCE.sha256, SQUARE_SOURCE.sha256);
  assert.notEqual(WORDMARK_DERIVED.sha256, SQUARE_DERIVED.sha256);
  assert.notEqual(WORDMARK_SOURCE.sha256, WORDMARK_DERIVED.sha256);
  assert.notEqual(SQUARE_SOURCE.sha256, SQUARE_DERIVED.sha256);
});

test('five accepted static mappings keep frozen pixels', async () => {
  for (const [relative, expected] of Object.entries(FROZEN_README_STATICS)) {
    await assertExactAsset(relative, expected, 'jpeg');
  }
});

test('README final-art links stay static-only, inventoried, and free of rejected assets', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const plugin = JSON.parse(await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  const { images, links } = collectMarkdownMedia(readme);
  const expectedImages = Object.values(PUBLISHED_README_STILLS);
  assert.deepEqual([...images].sort(), [...expectedImages].sort());
  for (const still of expectedImages) {
    assert.equal(links.has(still), true, still);
    assert.match(still, SAFE_RELATIVE);
    assert.equal(still.startsWith(`${FINAL_DOCS}/`), true, still);
    await access(path.join(REPO, still));
  }
  for (const haystack of publicHaystacks(readme, plugin, marketplace)) {
    for (const stale of REJECTED_PUBLIC_PATHS) {
      assert.equal(haystack.includes(stale), false, stale);
    }
    assert.doesNotMatch(haystack, /hero-muted\.(?:mp4|webm)/u);
    assert.doesNotMatch(haystack, /multi-lane[^"\s]*held/u);
    assert.doesNotMatch(haystack, /mark\.svg/u);
  }
  assert.equal(marketplace.interface.poster, PUBLISHED_README_STILLS['hero-demo']);
  assert.equal(marketplace.interface.logo, WORDMARK_DERIVED.plugin);
  assert.equal(marketplace.interface.heroMp4, undefined);
  assert.equal(marketplace.interface.heroWebm, undefined);
  assert.equal(plugin.interface.poster, `./${FINAL_PLUGIN}/derived/hero-demo.jpg`);
  assert.equal(plugin.interface.logo, `./${FINAL_PLUGIN}/derived/wordmark.png`);
  assert.equal(plugin.interface.composerIcon, `./${FINAL_PLUGIN}/derived/square-mark.png`);
  assert.equal(plugin.interface.heroMp4, undefined);
  assert.equal(plugin.interface.heroWebm, undefined);
});

test('README alt text is meaningful and does not claim exact host screenshots', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const { alts } = collectMarkdownMedia(readme);
  assert.equal(alts.length, 5);
  const byTarget = Object.fromEntries(alts.map((entry) => [entry.target, entry.alt]));
  assert.equal(
    byTarget[PUBLISHED_README_STILLS['hero-demo']],
    'Give Codex a team of external co-engineers without giving up control.',
  );
  assert.match(byTarget[PUBLISHED_README_STILLS['first-delegation']], /conceptual illustration/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['first-delegation']], /Grok/u);
  assert.match(byTarget[PUBLISHED_README_STILLS['first-delegation']], /one (?:explicit )?Grok assignment|one submission|verified candidate/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['provider-choices']], /conceptual illustration/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['provider-choices']], /Grok, Cursor, and Muse/u);
  assert.match(byTarget[PUBLISHED_README_STILLS['failure-unresolved']], /conceptual illustration/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['failure-unresolved']], /failed or stayed unresolved|no verified candidate/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['install-auth']], /conceptual illustration/iu);
  assert.match(byTarget[PUBLISHED_README_STILLS['install-auth']], /install/iu);
  for (const entry of alts) {
    assert.ok(entry.alt.length >= 24, entry.target);
    assert.doesNotMatch(entry.alt, /exact host screenshot/iu);
    assert.doesNotMatch(entry.alt, /^screenshot of/iu);
    assert.doesNotMatch(entry.alt, /placeholder/iu);
    assert.doesNotMatch(entry.alt, /held/iu);
    assert.doesNotMatch(entry.alt, /malformed/iu);
    assert.equal(entry.alt.includes(path.basename(entry.target)), false, entry.target);
  }
});

test('optional absent slots have no images and public README has no art-QA prose', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const slotContract = await readFile(path.join(REPO, 'docs', 'readme-image-slot-contract.md'), 'utf8');
  const bounds = {
    'multi-lane-run': 'If you have no saved profile',
    'grouped-attention': 'That answer is chatting',
    'verified-final-decision': 'If a required assignment fails',
  };
  for (const slot of OPTIONAL_SLOTS) {
    const marker = `<!-- README_ART_SLOT: ${slot} -->`;
    const index = readme.indexOf(marker);
    assert.ok(index !== -1, slot);
    const end = readme.indexOf(bounds[slot], index);
    assert.ok(end > index, slot);
    const after = readme.slice(index, end);
    assert.doesNotMatch(after, /!\[[^\]]*\]\([^)]+\)/u);
    assert.doesNotMatch(after, /This image slot is held/u);
    assert.doesNotMatch(after, /malformed/iu);
    assert.doesNotMatch(after, /placeholder/iu);
    assert.match(slotContract, new RegExp(`${slot}[\\s\\S]*optional future exact-host enhancement`, 'iu'));
    assert.match(slotContract, new RegExp(`${slot}[\\s\\S]*not a REL-01 input`, 'iu'));
  }
  assert.doesNotMatch(readme, /This image slot is held/u);
  assert.doesNotMatch(readme, /malformed/iu);
  assert.doesNotMatch(readme, /placeholder/iu);
  assert.doesNotMatch(readme, /missing source/iu);
  assert.doesNotMatch(readme, /not published/iu);
  assert.match(readme, /Independent assignments stay isolated/u);
  assert.match(readme, /One grouped decision covers every assignment that asked/u);
  assert.match(readme, /verified result is an evidence packet/u);
});

test('README does not autoplay audio and does not embed a GitHub video player', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /There is no autoplay audio/u);
  assert.doesNotMatch(readme, /<video\b/iu);
  assert.doesNotMatch(readme, /<audio\b/iu);
  assert.doesNotMatch(readme, /autoplay=/iu);
  assert.doesNotMatch(readme, /Optional silent architecture animation/u);
});

test('package and marketplace stay on 3.4.2 with the five-tool catalog', async () => {
  const plugin = JSON.parse(await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  assert.equal(plugin.version, '3.4.2');
  assert.equal(marketplace.plugins[0].version, '3.4.2');
  assert.equal(packageJson.version, '3.4.2');
  assert.match(readme, /The catalog remains exactly `status`, `delegate`, `task`, `tasks`, and\s+`cancel`/u);
  for (const tool of FIVE_TOOLS) {
    assert.match(readme, new RegExp(`\`${tool}\``, 'u'));
  }
  assert.doesNotMatch(JSON.stringify(plugin), /3\.1\.0/u);
  assert.doesNotMatch(JSON.stringify(marketplace), /3\.1\.0/u);
  assert.doesNotMatch(JSON.stringify(plugin), /missing raster/iu);
  assert.doesNotMatch(JSON.stringify(marketplace), /missing raster/iu);
  assert.doesNotMatch(JSON.stringify(plugin), /Four raster-logo originals were not supplied/u);
  assert.doesNotMatch(JSON.stringify(marketplace), /Four raster-logo originals were not supplied/u);
});

test('offline package inventory ships identity rasters and accepted statics, not held public files', async () => {
  const packed = JSON.parse(
    execFileSync(
      'npm',
      ['pack', './plugins/codex-co-engineer', '--dry-run', '--ignore-scripts', '--offline', '--json'],
      { cwd: REPO, encoding: 'utf8' },
    ),
  );
  const report = Array.isArray(packed) ? packed[0] : packed;
  const files = new Map((report.files ?? []).map((entry) => [entry.path.replace(/^\.\//u, ''), entry.size]));
  const required = {
    'assets/experience/final/derived/wordmark.png': WORDMARK_DERIVED.bytes,
    'assets/experience/final/derived/square-mark.png': SQUARE_DERIVED.bytes,
    'assets/experience/final/derived/hero-demo.jpg': 31741,
    'assets/experience/final/derived/first-delegation.jpg': 24983,
    'assets/experience/final/derived/provider-choices.jpg': 30552,
    'assets/experience/final/derived/failure-unresolved.jpg': 41986,
    'assets/experience/final/derived/install-auth.jpg': 17675,
    'assets/experience/final/sources/chatgpt-image-aug-27-2026-square-mark.png': SQUARE_SOURCE.bytes,
    '.codex-plugin/plugin.json': undefined,
  };
  for (const [relative, bytes] of Object.entries(required)) {
    assert.equal(files.has(relative), true, `package missing ${relative}`);
    if (typeof bytes === 'number') assert.equal(files.get(relative), bytes, relative);
  }
  assert.equal(
    [...files.entries()].some(([name, size]) => (
      name.startsWith('assets/experience/final/sources/')
      && name.endsWith('.png')
      && size === WORDMARK_SOURCE.bytes
    )),
    true,
    'package missing wordmark original',
  );
  assert.equal(files.has('docs/assets/co-engineer-3.4.0/sources/source-a.mp4'), false);
});

test('final-art public references are manifest-backed and never held or malformed', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const slotContract = await readFile(path.join(REPO, 'docs', 'readme-image-slot-contract.md'), 'utf8');
  const plugin = JSON.parse(await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  const { links } = collectMarkdownMedia(readme);
  const manifest = JSON.parse(await readFile(path.join(REPO, MANIFEST_RELATIVE), 'utf8'));
  const declared = Object.values(PUBLISHED_README_STILLS);
  for (const relative of declared) {
    assert.match(relative, SAFE_RELATIVE);
    assert.equal(relative.includes(' '), false);
    assert.equal(slotContract.includes(relative), true, relative);
    assert.equal(links.has(relative), true, relative);
  }
  assert.equal(manifest.plugin_version, '3.3.0');
  assert.equal(manifest.package_version, '3.3.0');
  assert.equal(manifest.static_first, true);
  assert.equal(manifest.shipping_interface.heroMp4, null);
  assert.equal(manifest.shipping_interface.heroWebm, null);
  assert.equal(manifest.shipping_interface.composerIcon, SQUARE_DERIVED.plugin);
  assert.equal(manifest.shipping_interface.logo, WORDMARK_DERIVED.plugin);
  const byPath = Object.fromEntries(manifest.inventory.map((entry) => [entry.path, entry]));
  for (const relative of declared) {
    assert.equal(byPath[relative].publishable, true, relative);
    assert.equal(byPath[relative].sha256, FROZEN_README_STATICS[relative].sha256, relative);
  }
  for (const relative of REJECTED_PUBLIC_PATHS.filter((item) => item.startsWith(`${FINAL_DOCS}/derived/`))) {
    if (!byPath[relative]) continue;
    assert.equal(byPath[relative].publishable, false, relative);
    assert.equal(links.has(relative), false, relative);
  }
  for (const slot of OPTIONAL_SLOTS) {
    assert.equal(manifest.slot_mapping[slot].publishable, false, slot);
    assert.equal(manifest.slot_mapping[slot].optional, true, slot);
    assert.equal(manifest.slot_mapping[slot].rel01_required, false, slot);
  }
  const publicText = publicHaystacks(readme, plugin, marketplace).join('\n');
  assert.doesNotMatch(publicText, /This image slot is held/u);
  assert.doesNotMatch(publicText, /Changes return ition/u);
});
