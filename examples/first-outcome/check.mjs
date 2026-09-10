import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { VERSION } = require(path.join(root, 'lib', 'version.js'));

assert.equal(VERSION, '1.0.0-first-outcome');
process.stdout.write('first-outcome acceptance passed\n');
