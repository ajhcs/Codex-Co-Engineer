'use strict';

/**
 * Summarize named check results from a JSON array.
 *
 * Each element must be `{ "name": string, "status": "passed"|"failed"|"skipped" }`.
 * Returns `{ passed, failed, skipped, failures }` where `failures` is the ordered
 * list of names whose status is `failed`.
 *
 * Intentionally incomplete starter stub: replace this body so `node check.mjs` passes.
 * Do not edit `check.mjs` to force a pass.
 */
function summarizeChecks(_checks) {
  throw new Error('summarizeChecks is not implemented');
}

function formatSummary(summary) {
  const lines = [
    `passed: ${summary.passed}`,
    `failed: ${summary.failed}`,
    `skipped: ${summary.skipped}`,
    'failures:',
    ...summary.failures.map((name) => `- ${name}`),
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { summarizeChecks, formatSummary };
