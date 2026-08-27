// UX-05 brand assets: freeze provenance, muted derivatives, size ceilings,
// GitHub/README relative contracts, and honest marketplace copy.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const CONTRACT_JSON = path.join(HERE, 'fixtures', 'v3-experience-contract.json');
const PROVENANCE = path.join(REPO, 'docs', 'brand-asset-provenance.md');

const FORBIDDEN_CLAIMS = Object.freeze([
  'credit reduction',
  '8x speed',
  'universal UI',
  'SOTA routing',
]);

const FORBIDDEN_PROVIDER = Object.freeze([
  'Using DSH Co-Engineer',
  'Using Ox Co-Engineer',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function folded(source) {
  return String(source).replace(/\s+/gu, ' ');
}

function isImmediatelyNegated(prefix) {
  const clause = prefix
    .split(/(?:[.;!?]|\bbut\b|\bhowever\b)/iu)
    .at(-1)
    .slice(-240);
  if (/\bnot\s+only\b/iu.test(clause)) return false;
  return /\b(?:may|might|must|shall|will|can|could|does?|did|do)\s+not\b/iu.test(clause)
    || /\b(?:never|cannot|can't)\b/iu.test(clause)
    || /\bdo not (?:claim|teach|add|imply|name)\b/iu.test(clause);
}

function hasUnnegatedMatch(source, pattern) {
  const text = folded(source);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, match.index - 320), match.index);
    if (isImmediatelyNegated(prefix)) continue;
    return true;
  }
  return false;
}

function loadProvenanceJson(markdown) {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/u);
  if (!match) fail('Provenance document is missing the inventory JSON fence.');
  return JSON.parse(match[1]);
}

function jpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) fail('JPEG magic missing.');
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
  fail('JPEG SOF marker missing.');
}

function mp4Handlers(buffer) {
  const handlers = [];
  let index = 0;
  while (index >= 0) {
    index = buffer.indexOf('hdlr', index);
    if (index === -1) break;
    handlers.push(buffer.subarray(index + 12, index + 16).toString('ascii'));
    index += 4;
  }
  return handlers;
}

function probe(relative) {
  try {
    const raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', relative],
      { cwd: REPO, encoding: 'utf8' },
    );
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoAudio(relative, buffer, expectedCodec, expectedWidth, expectedHeight) {
  if (relative.endsWith('.mp4')) {
    const handlers = mp4Handlers(buffer);
    assert.equal(handlers.includes('soun'), false, `${relative} has an audio handler`);
    assert.equal(handlers.includes('vide'), true, `${relative} missing vide handler`);
    assert.equal(buffer.includes(Buffer.from('mp4a')), false, `${relative} still contains AAC`);
    assert.equal(buffer.includes(Buffer.from('avc1')), true, `${relative} missing avc1`);
  }
  if (relative.endsWith('.webm')) {
    assert.match(buffer.toString('latin1'), /V_VP9/u);
    assert.doesNotMatch(buffer.toString('latin1'), /A_OPUS|A_VORBIS|A_AAC/u);
  }

  const probed = probe(relative);
  if (!probed) return;
  const audio = (probed.streams ?? []).filter((stream) => stream.codec_type === 'audio');
  assert.equal(audio.length, 0, `${relative} ffprobe found audio`);
  assert.equal(Number(probed.format?.nb_streams), 1);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video?.codec_name, expectedCodec);
  assert.equal(video?.width, expectedWidth);
  assert.equal(video?.height, expectedHeight);
  assert.equal(video?.avg_frame_rate, '24/1');
}

async function fileExists(relative) {
  try {
    await access(path.join(REPO, relative));
    return true;
  } catch {
    return false;
  }
}

test('provenance inventory hashes, sizes, and source identity match the tree', async () => {
  const markdown = await readFile(PROVENANCE, 'utf8');
  const provenance = loadProvenanceJson(markdown);
  const fixture = JSON.parse(await readFile(CONTRACT_JSON, 'utf8'));

  assert.equal(provenance.schema, 'codex-co-engineer.brand-asset-provenance.v1');
  assert.equal(provenance.plugin_version, '3.3.0');
  assert.equal(provenance.product_lead, fixture.product_lead);
  assert.equal(provenance.honest_claim, fixture.honest_claim.statement);
  assert.deepEqual(provenance.canonical_phrases, fixture.canonical_phrases);
  assert.equal(provenance.absent_raster_logos.count, 4);
  assert.equal(provenance.absent_raster_logos.bytes, null);
  assert.match(
    provenance.absent_raster_logos.statement,
    /Four raster-logo originals were not supplied/u,
  );
  assert.equal(
    provenance.sources[0].sha256,
    '43952f17186800caa0fb024f5f9169509dac4921749a03af0b8c832d7bd31787',
  );
  assert.equal(
    provenance.sources[1].sha256,
    '7d2bca8d1481d5142a92ed10024710080fb887b5f539bb2de9ef943875c29bf7',
  );
  assert.notEqual(provenance.sources[0].sha256, provenance.sources[1].sha256);

  for (const entry of provenance.inventory) {
    const absolute = path.join(REPO, entry.path);
    const bytes = await readFile(absolute);
    const info = await stat(absolute);
    assert.equal(info.isFile(), true, entry.path);
    assert.equal(info.size, entry.bytes, entry.path);
    assert.equal(sha256(bytes), entry.sha256, entry.path);
    const ceiling = provenance.size_ceilings[entry.path];
    if (typeof ceiling === 'number') {
      assert.ok(info.size <= ceiling, `${entry.path} exceeds ceiling ${ceiling}`);
    }
  }

  const historical = await readFile(path.join(REPO, provenance.historical_unaltered.path));
  assert.equal(sha256(historical), provenance.historical_unaltered.sha256);
  assert.deepEqual([...historical.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('muted derivatives keep 30:17 aspect, 24fps content, and no audio', async () => {
  const provenance = loadProvenanceJson(await readFile(PROVENANCE, 'utf8'));
  for (const entry of provenance.inventory) {
    if (!entry.muted) continue;
    const buffer = await readFile(path.join(REPO, entry.path));
    if (entry.codec === 'h264' || entry.codec === 'vp9') {
      assert.equal(entry.audio, false, entry.path);
      assert.match(entry.path, /muted/u);
      assert.equal(entry.width / entry.height, 1920 / 1088, entry.path);
      assertNoAudio(
        entry.path,
        buffer,
        entry.codec === 'h264' ? 'h264' : 'vp9',
        entry.width,
        entry.height,
      );
    }
    if (entry.codec === 'jpeg') {
      const size = jpegSize(buffer);
      assert.equal(size.width, entry.width, entry.path);
      assert.equal(size.height, entry.height, entry.path);
      assert.equal(size.width / size.height, 1920 / 1088, entry.path);
    }
  }

  for (const id of ['A', 'B']) {
    const source = provenance.sources.find((entry) => entry.id === id);
    const probed = probe(source.repo_path);
    if (!probed) continue;
    assert.equal(Number(probed.format.nb_streams), 3);
    assert.equal(probed.format.duration, '6.041667');
    const kinds = probed.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`);
    assert.deepEqual(kinds, ['video:h264', 'audio:aac', 'video:mjpeg']);
    assert.equal(probed.streams[0].width, 1920);
    assert.equal(probed.streams[0].height, 1088);
    assert.equal(probed.streams[0].avg_frame_rate, '24/1');
    assert.equal(probed.streams[2].disposition.attached_pic, 1);
  }
});

test('readable posters carry the product contract and are not blank', async () => {
  const fixture = JSON.parse(await readFile(CONTRACT_JSON, 'utf8'));
  const posters = [
    'docs/assets/co-engineer-3.4.0/poster.svg',
    'plugins/codex-co-engineer/assets/experience/poster.svg',
    'docs/assets/co-engineer-3.4.0/mark.svg',
    'plugins/codex-co-engineer/assets/experience/mark.svg',
  ];
  for (const relative of posters) {
    const text = await readFile(path.join(REPO, relative), 'utf8');
    assert.match(text, /interlocking-link mark/u);
    assert.match(text, /Not a pixel-faithful copy of absent raster logos/u);
    if (relative.endsWith('mark.svg')) {
      assert.match(text, /aria-label="Co-Engineer"/u);
    }
    if (relative.endsWith('poster.svg')) {
      assert.match(text, /aria-label="Give Codex a team of external co-engineers without giving up control."/u);
      assert.equal(text.includes(fixture.product_lead), true, relative);
      assert.equal(text.includes(fixture.honest_claim.statement), true, relative);
      for (const phrase of fixture.canonical_phrases) {
        assert.equal(text.includes(phrase), true, `${relative} missing ${phrase}`);
      }
      assert.match(text, /No autoplay audio/u);
    }
  }

  const docsMark = await readFile(path.join(REPO, 'docs/assets/co-engineer-3.4.0/mark.svg'));
  const pluginMark = await readFile(
    path.join(REPO, 'plugins/codex-co-engineer/assets/experience/mark.svg'),
  );
  assert.deepEqual(docsMark, pluginMark);

  for (const relative of [
    'docs/assets/co-engineer-3.4.0/poster.jpg',
    'plugins/codex-co-engineer/assets/experience/poster.jpg',
  ]) {
    const buffer = await readFile(path.join(REPO, relative));
    const size = jpegSize(buffer);
    assert.equal(size.width / size.height, 1920 / 1088, relative);
    let dark = 0;
    let light = 0;
    for (let i = 0; i < buffer.length; i += 97) {
      const value = buffer[i];
      if (value < 64) dark += 1;
      if (value > 192) light += 1;
    }
    assert.ok(dark > 8 && light > 8, `${relative} lacks readable contrast samples`);
  }
});

test('plugin package inventory includes experience media and excludes originals', async () => {
  const provenance = loadProvenanceJson(await readFile(PROVENANCE, 'utf8'));
  const packed = JSON.parse(
    execFileSync(
      'npm',
      ['pack', './plugins/codex-co-engineer', '--dry-run', '--ignore-scripts', '--offline', '--json'],
      { cwd: REPO, encoding: 'utf8' },
    ),
  );
  const report = Array.isArray(packed) ? packed[0] : packed;
  const files = new Map((report.files ?? []).map((entry) => [entry.path.replace(/^\.\//u, ''), entry.size]));

  const experience = provenance.inventory.filter((entry) => entry.path.startsWith('plugins/codex-co-engineer/assets/experience/'));
  let total = 0;
  for (const entry of experience) {
    const name = entry.path.slice('plugins/codex-co-engineer/'.length);
    assert.equal(files.has(name), true, `package missing ${name}`);
    assert.equal(files.get(name), entry.bytes, name);
    total += entry.bytes;
  }
  assert.ok(total <= provenance.size_ceilings.plugin_experience_total, `experience total ${total}`);
  assert.equal(files.has('assets/experience/hero-muted.mp4'), true);
  assert.equal(files.has('assets/experience/hero-muted.webm'), true);
  assert.equal(files.has('docs/assets/co-engineer-3.4.0/sources/source-a.mp4'), false);
  assert.equal(files.has('assets/co-engineer.png'), true);
});

test('marketplace and plugin metadata stay on 3.3.0, UX-01 language, and 3.4.0 assets', async () => {
  const fixture = JSON.parse(await readFile(CONTRACT_JSON, 'utf8'));
  const plugin = JSON.parse(
    await readFile(path.join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  const marketplace = JSON.parse(
    await readFile(path.join(REPO, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
  );
  const provenanceText = await readFile(PROVENANCE, 'utf8');
  const poster = await readFile(path.join(REPO, 'docs/assets/co-engineer-3.4.0/poster.svg'), 'utf8');

  assert.equal(plugin.version, '3.3.0');
  assert.equal(marketplace.plugins[0].version, '3.3.0');
  for (const text of [
    JSON.stringify(plugin),
    JSON.stringify(marketplace),
    provenanceText,
    poster,
  ]) {
    for (const claim of FORBIDDEN_CLAIMS) {
      const pattern = new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu');
      assert.equal(hasUnnegatedMatch(text, pattern), false, claim);
    }
    for (const phrase of FORBIDDEN_PROVIDER) {
      assert.equal(text.includes(phrase), false, phrase);
    }
  }
  assert.doesNotMatch(JSON.stringify(plugin), /3\.1\.0|codex-co-engineer-3\.1\.0/u);
  assert.doesNotMatch(JSON.stringify(marketplace), /3\.1\.0|codex-co-engineer-3\.1\.0/u);
  assert.equal(plugin.description.includes(fixture.product_lead), true);
  assert.equal(plugin.description.includes(fixture.honest_claim.statement), true);
  for (const relative of [
    'docs/assets/co-engineer-3.4.0/poster.jpg',
    'docs/assets/co-engineer-3.4.0/hero-muted.mp4',
    'plugins/codex-co-engineer/assets/experience/mark.svg',
  ]) {
    assert.match(relative, /^[A-Za-z0-9./_-]+$/u);
    assert.equal(relative.includes(' '), false);
  }
});

test('no new raster logos were invented for the four absent originals', async () => {
  const pngs = [];
  for (const directory of [
    path.join(REPO, 'docs', 'assets', 'co-engineer-3.4.0'),
    path.join(PLUGIN, 'assets', 'experience'),
  ]) {
    const names = await readdir(directory);
    for (const name of names) {
      if (name.endsWith('.png')) pngs.push(name);
    }
  }
  assert.deepEqual(pngs, []);
  assert.equal(await fileExists('docs/assets/co-engineer-3.4.0/logo.png'), false);
  assert.equal(await fileExists('plugins/codex-co-engineer/assets/experience/logo.png'), false);
});
