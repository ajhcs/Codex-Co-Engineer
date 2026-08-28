import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');

const FINAL_DOCS = 'docs/assets/co-engineer-3.4.0/final';
const FINAL_PLUGIN = 'assets/experience/final';
const MANIFEST_RELATIVE = `${FINAL_DOCS}/manifest.json`;

const PUBLISHED_README_STILLS = Object.freeze({
  'hero-demo': `${FINAL_DOCS}/hero-architecture.png`,
  'first-delegation': `${FINAL_DOCS}/first-delegation.jpg`,
  'provider-choices': `${FINAL_DOCS}/provider-choices.jpg`,
  'failure-unresolved': `${FINAL_DOCS}/failure-unresolved.jpg`,
  'install-auth': `${FINAL_DOCS}/install-auth.jpg`,
});

const HERO_MOTION = Object.freeze([
  `${FINAL_DOCS}/hero-architecture-silent.mp4`,
  `${FINAL_DOCS}/hero-architecture-silent.webm`,
]);

const HELD_SLOTS = Object.freeze(['grouped-attention', 'verified-final-decision']);

const STALE_PATHS = Object.freeze([
  'docs/assets/co-engineer-3.4.0/poster.jpg',
  'docs/assets/co-engineer-3.4.0/hero-muted.mp4',
  'docs/assets/co-engineer-3.4.0/hero-muted.webm',
  'docs/assets/codex-co-engineer-3.1.0.jpg',
  'docs/assets/codex-co-engineer-3.1.0.svg',
  './assets/experience/poster.jpg',
  './assets/experience/hero-muted.mp4',
  './assets/experience/hero-muted.webm',
]);

const SAFE_RELATIVE = /^[A-Za-z0-9./_-]+$/u;

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

function findPublishable(manifest, matcher) {
  if (!manifest || typeof manifest !== 'object') return null;
  const assets = manifest.assets;
  const candidates = [];
  if (Array.isArray(assets)) candidates.push(...assets);
  else if (assets && typeof assets === 'object') {
    for (const [id, value] of Object.entries(assets)) {
      candidates.push({ id, ...(value && typeof value === 'object' ? value : { path: value }) });
    }
  }
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const haystack = [entry.id, entry.slot, entry.path, entry.docs, entry.plugin, ...collectStrings(entry)];
    if (haystack.some((item) => typeof item === 'string' && matcher(item))) {
      if (typeof entry.publishable === 'boolean') return entry.publishable;
    }
  }
  if (typeof manifest.publishable === 'boolean') return manifest.publishable;
  return null;
}

async function optionalFile(relative) {
  try {
    await access(path.join(REPO, relative));
    const info = await stat(path.join(REPO, relative));
    return info.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(path.join(REPO, MANIFEST_RELATIVE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

test('README final-art links stay relative, inventoried, and free of stale scaffolding', async () => {
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
  }
  for (const motion of HERO_MOTION) {
    assert.equal(links.has(motion), true, motion);
    assert.ok(readme.indexOf(PUBLISHED_README_STILLS['hero-demo']) < readme.indexOf(motion));
  }
  assert.equal(links.has(`${FINAL_DOCS}/multi-lane-supplemental-poster.webp`), false);
  assert.equal(links.has(`${FINAL_DOCS}/multi-lane-supplemental-silent.mp4`), false);
  assert.equal(links.has(`${FINAL_DOCS}/multi-lane-supplemental-silent.webm`), false);
  assert.doesNotMatch(readme, /multi-lane-run\.(?:jpg|jpeg|png|webp)/u);
  for (const stale of STALE_PATHS) {
    assert.equal(readme.includes(stale), false, stale);
    assert.equal(JSON.stringify(plugin).includes(stale), false, stale);
    assert.equal(JSON.stringify(marketplace).includes(stale), false, stale);
  }
  assert.equal(marketplace.interface.poster, PUBLISHED_README_STILLS['hero-demo']);
  assert.equal(marketplace.interface.heroMp4, HERO_MOTION[0]);
  assert.equal(marketplace.interface.heroWebm, HERO_MOTION[1]);
  assert.equal(plugin.interface.poster, `./${FINAL_PLUGIN}/hero-architecture.png`);
  assert.equal(plugin.interface.heroMp4, `./${FINAL_PLUGIN}/hero-architecture-silent.mp4`);
  assert.equal(plugin.interface.heroWebm, `./${FINAL_PLUGIN}/hero-architecture-silent.webm`);
  for (const relative of [...expectedImages, ...HERO_MOTION]) {
    if (await optionalFile(relative)) {
      const info = await stat(path.join(REPO, relative));
      assert.equal(info.isFile(), true, relative);
    }
  }
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
    assert.equal(entry.alt.includes(path.basename(entry.target)), false, entry.target);
  }
});

test('README keeps grouped-attention and verified-final-decision holds', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const slotContract = await readFile(path.join(REPO, 'docs', 'readme-image-slot-contract.md'), 'utf8');
  const holdBounds = {
    'grouped-attention': 'That answer is chatting',
    'verified-final-decision': "Verification is Codex's review",
  };
  for (const slot of HELD_SLOTS) {
    const marker = `<!-- README_ART_SLOT: ${slot} -->`;
    const index = readme.indexOf(marker);
    assert.ok(index !== -1, slot);
    const end = readme.indexOf(holdBounds[slot], index);
    assert.ok(end > index, slot);
    const after = readme.slice(index, end);
    assert.match(after, /This image slot is held/u);
    assert.doesNotMatch(after, /!\[[^\]]*\]\([^)]+\)/u);
  }
  assert.match(
    readme,
    /No supplied source shows grouped questions,\s+affected and unaffected lanes, one structured response, and same-cursor\s+resume together/u,
  );
  assert.match(
    readme,
    /Conceptual outcome art lacks branch, head, and\s+tree identities plus the scope, tests, reviews, candidate, and\s+sanitized-evidence contract/u,
  );
  assert.match(slotContract, /No supplied source shows grouped questions/u);
  assert.match(slotContract, /lacks branch\/head\/tree, scope, tests, reviews, candidate, and sanitized-evidence contract/u);
});

test('README does not autoplay audio and does not embed a GitHub video player', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /There is no autoplay audio/u);
  assert.match(readme, /GitHub README Markdown cannot guarantee\s+video playback or reduced-motion behavior/u);
  assert.doesNotMatch(readme, /<video\b/iu);
  assert.doesNotMatch(readme, /<audio\b/iu);
  assert.doesNotMatch(readme, /autoplay=/iu);
  assert.doesNotMatch(readme, /\bautoplay\b(?!\s+audio)/iu);
});

test('package and marketplace stay on 3.3.0 with the five-tool catalog', async () => {
  const plugin = JSON.parse(await readFile(path.join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  assert.equal(plugin.version, '3.3.0');
  assert.equal(marketplace.plugins[0].version, '3.3.0');
  assert.equal(packageJson.version, '3.3.0');
  assert.match(readme, /The catalog remains exactly `status`, `delegate`, `task`, `tasks`, and\s+`cancel`/u);
  assert.doesNotMatch(JSON.stringify(plugin), /3\.1\.0/u);
  assert.doesNotMatch(JSON.stringify(marketplace), /3\.1\.0/u);
  assert.doesNotMatch(JSON.stringify(plugin), /missing raster/iu);
  assert.doesNotMatch(JSON.stringify(marketplace), /missing raster/iu);
  assert.doesNotMatch(JSON.stringify(plugin), /Four raster-logo originals were not supplied/u);
  assert.doesNotMatch(JSON.stringify(marketplace), /Four raster-logo originals were not supplied/u);
});

test('final-art references are structurally valid and manifest-backed when composed', async () => {
  const readme = await readFile(path.join(REPO, 'README.md'), 'utf8');
  const slotContract = await readFile(path.join(REPO, 'docs', 'readme-image-slot-contract.md'), 'utf8');
  const { links } = collectMarkdownMedia(readme);
  const manifest = await loadManifest();
  const declared = [...Object.values(PUBLISHED_README_STILLS), ...HERO_MOTION];
  for (const relative of declared) {
    assert.match(relative, SAFE_RELATIVE);
    assert.equal(relative.includes(' '), false);
    assert.equal(slotContract.includes(relative), true, relative);
    assert.equal(links.has(relative), true, relative);
  }
  assert.match(slotContract, /multi-lane-supplemental-silent\.mp4/u);
  assert.match(slotContract, /publishable=true/u);
  assert.match(readme, /malformed and is not published/u);
  assert.match(readme, /conceptual only and is published only/u);
  assert.match(readme, /manifest\.json` records\s+`publishable=true`/u);

  if (!manifest) return;

  const strings = collectStrings(manifest);
  for (const relative of declared) {
    const basename = path.posix.basename(relative);
    assert.equal(
      strings.some((value) => value === relative || value.endsWith(basename) || value.includes(basename)),
      true,
      `manifest missing ${relative}`,
    );
    const publishable = findPublishable(
      manifest,
      (item) => item === relative || item.endsWith(basename) || item.includes(basename),
    );
    assert.notEqual(publishable, false, relative);
  }
  const multiLaneLinked = [...links].some((target) => target.includes('multi-lane-supplemental'));
  if (multiLaneLinked) {
    const publishable = findPublishable(
      manifest,
      (item) => /multi-lane-supplemental/u.test(item),
    );
    assert.equal(publishable, true, 'linked multi-lane motion requires publishable=true');
  }
});
