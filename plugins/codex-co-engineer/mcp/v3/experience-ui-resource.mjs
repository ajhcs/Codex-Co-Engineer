import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  EXPERIENCE_UI_RESOURCE_URIS,
  MCP_APPS_MIME_TYPE,
  clientSupportsMcpApps,
  createExperienceUiResourceRegistry,
  isMcpAppsResourceUri,
} from './response.mjs';

export const MCP_RESOURCE_NOT_FOUND = -32002;
export const DISPLAY_ONLY_EXPERIENCE_UI_CARDS = Object.freeze(['run', 'final']);
export const INLINE_EXPERIENCE_UI_CARDS = Object.freeze(['run', 'attention', 'final']);
export const INLINE_EXPERIENCE_UI_URIS = Object.freeze({
  run: EXPERIENCE_UI_RESOURCE_URIS.run,
  attention: EXPERIENCE_UI_RESOURCE_URIS.attention,
  final: EXPERIENCE_UI_RESOURCE_URIS.final,
});
export const INLINE_EXPERIENCE_UI_NAMES = Object.freeze({
  run: 'Co-Engineer run',
  attention: 'Co-Engineer grouped attention',
  final: 'Co-Engineer final decision',
});

const UI_DIR = new URL('./ui/', import.meta.url);
const ALLOWED_INLINE_URIS = new Set(Object.values(INLINE_EXPERIENCE_UI_URIS));

function readUi(name) {
  return readFileSync(new URL(name, UI_DIR), 'utf8');
}

const DISPLAY_ONLY_SOURCE = readUi('display-only.js');
const ATTENTION_SOURCE = readUi('attention.js');
const FOUNDATION_CSS = readUi('foundation.css');

function loadUiApis() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DISPLAY_ONLY_SOURCE, sandbox, {
    filename: fileURLToPath(new URL('display-only.js', UI_DIR)),
  });
  vm.runInContext(ATTENTION_SOURCE, sandbox, {
    filename: fileURLToPath(new URL('attention.js', UI_DIR)),
  });
  const display = sandbox.CodexCoEngineerExperienceUi;
  const attention = sandbox.CodexCoEngineerAttentionUi;
  if (!display || typeof display !== 'object') {
    throw new Error('Display-only experience UI failed to load.');
  }
  if (!attention || typeof attention !== 'object') {
    throw new Error('Attention experience UI failed to load.');
  }
  return { display, attention };
}

const loaded = loadUiApis();
export const CodexCoEngineerExperienceUi = loaded.display;
export const CodexCoEngineerAttentionUi = loaded.attention;

function sealedRegistry(registry) {
  return Object.freeze({
    get: (uri) => registry.get(uri),
    exists: (uri) => registry.exists(uri),
    list: () => registry.list(),
    register: () => false,
    unregister: () => false,
    clear: () => {},
  });
}

function assembleDocument(card, template) {
  const attentionBoot = card === 'attention'
    ? `if (globalThis.document) {
  const start = () => globalThis.CodexCoEngineerAttentionUi.connectAttentionCard(globalThis.document);
  if (globalThis.document.readyState === 'loading') {
    globalThis.document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
`
    : `if (globalThis.document) {
  const start = () => globalThis.CodexCoEngineerExperienceUi.connectDisplayOnlyCard(globalThis.document);
  if (globalThis.document.readyState === 'loading') {
    globalThis.document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
`;
  const script = card === 'attention'
    ? `${DISPLAY_ONLY_SOURCE}
${ATTENTION_SOURCE}
${attentionBoot}`
    : `${DISPLAY_ONLY_SOURCE}
${attentionBoot}`;
  return template
    .replace('<!--CCE_CSS-->', FOUNDATION_CSS)
    .replace('<!--CCE_JS-->', script);
}

function buildInlineRegistry() {
  const registry = createExperienceUiResourceRegistry();
  const documents = {
    run: assembleDocument('run', readUi('run.html')),
    attention: assembleDocument('attention', readUi('attention.html')),
    final: assembleDocument('final', readUi('final.html')),
  };
  for (const card of INLINE_EXPERIENCE_UI_CARDS) {
    registry.register({
      uri: INLINE_EXPERIENCE_UI_URIS[card],
      mimeType: MCP_APPS_MIME_TYPE,
      name: INLINE_EXPERIENCE_UI_NAMES[card],
      text: documents[card],
    });
  }
  return sealedRegistry(registry);
}

const inlineRegistry = buildInlineRegistry();
const emptyRegistry = sealedRegistry(createExperienceUiResourceRegistry());

export function clientAdvertisesResourceCapability(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const resources = capabilities.resources;
  return resources != null && typeof resources === 'object' && !Array.isArray(resources);
}

export function clientAdvertisesCompatibleAppsUi(capabilities) {
  return clientSupportsMcpApps(capabilities) && clientAdvertisesResourceCapability(capabilities);
}

export function experienceUiResourceRegistryForInlineCards() {
  return inlineRegistry;
}

export function experienceUiResourcesForClient(capabilities) {
  return clientAdvertisesCompatibleAppsUi(capabilities) ? inlineRegistry : emptyRegistry;
}

export function isRegisteredInlineExperienceUiUri(uri) {
  return ALLOWED_INLINE_URIS.has(uri) && isMcpAppsResourceUri(uri);
}

export function readInlineExperienceUiResource(uri) {
  if (!isRegisteredInlineExperienceUiUri(uri)) return null;
  return inlineRegistry.get(uri);
}

export function listInlineExperienceUiResources() {
  return inlineRegistry.list().map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    mimeType: MCP_APPS_MIME_TYPE,
  }));
}

export {
  EXPERIENCE_UI_RESOURCE_URIS,
  MCP_APPS_MIME_TYPE,
};
