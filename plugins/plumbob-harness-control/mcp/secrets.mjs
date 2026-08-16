import { readFile } from 'node:fs/promises';
import path from 'node:path';

const configRoot = process.env.XDG_CONFIG_HOME
  ?? path.join(process.env.HOME ?? '', '.config');

export const MODEL_API_KEY_FILE = process.env.CODEX_CO_ENGINEER_MODEL_API_KEY_FILE
  ?? process.env.PLUMBOB_HARNESS_MODEL_API_KEY_FILE
  ?? path.join(configRoot, 'codex-co-engineer', 'model-api-key');

const inheritedModelApiKey = process.env.MODEL_API_KEY?.trim() || '';

export async function loadModelApiKey() {
  if (inheritedModelApiKey) {
    process.env.MODEL_API_KEY = inheritedModelApiKey;
    return { available: true, source: 'environment' };
  }

  try {
    const key = (await readFile(MODEL_API_KEY_FILE, 'utf8')).trim();
    if (!key || /[\u0000-\u001f\u007f\s]/.test(key)) throw new Error('invalid key file');
    process.env.MODEL_API_KEY = key;
    return { available: true, source: 'protected_file' };
  } catch {
    delete process.env.MODEL_API_KEY;
    return { available: false, source: null };
  }
}
