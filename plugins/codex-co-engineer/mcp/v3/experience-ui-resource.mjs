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
export const INLINE_EXPERIENCE_UI_CARDS = Object.freeze(['run', 'final']);
export const INLINE_EXPERIENCE_UI_URIS = Object.freeze({
  run: EXPERIENCE_UI_RESOURCE_URIS.run,
  final: EXPERIENCE_UI_RESOURCE_URIS.final,
});
export const INLINE_EXPERIENCE_UI_NAMES = Object.freeze({
  run: 'Co-Engineer run',
  final: 'Co-Engineer final decision',
});

const UI_DIR = new URL('./ui/', import.meta.url);
const ALLOWED_INLINE_URIS = new Set(Object.values(INLINE_EXPERIENCE_UI_URIS));

function readUi(name) {
  return readFileSync(new URL(name, UI_DIR), 'utf8');
}

const DISPLAY_ONLY_SOURCE = readUi('display-only.js');
const FOUNDATION_CSS = readUi('foundation.css');

function loadDisplayOnlyApi() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DISPLAY_ONLY_SOURCE, sandbox, {
    filename: fileURLToPath(new URL('display-only.js', UI_DIR)),
  });
  const api = sandbox.CodexCoEngineerExperienceUi;
  if (!api || typeof api !== 'object') {
    throw new Error('Display-only experience UI failed to load.');
  }
  return api;
}

export const CodexCoEngineerExperienceUi = loadDisplayOnlyApi();

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

function assembleDocument(template) {
  const script = `${DISPLAY_ONLY_SOURCE}
if (globalThis.document) {
  const start = () => globalThis.CodexCoEngineerExperienceUi.connectDisplayOnlyCard(globalThis.document);
  if (globalThis.document.readyState === 'loading') {
    globalThis.document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
`;
  return template
    .replace('<!--CCE_CSS-->', FOUNDATION_CSS)
    .replace('<!--CCE_JS-->', script);
}

function buildInlineRegistry() {
  const registry = createExperienceUiResourceRegistry();
  const documents = {
    run: assembleDocument(readUi('run.html')),
    final: assembleDocument(readUi('final.html')),
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
