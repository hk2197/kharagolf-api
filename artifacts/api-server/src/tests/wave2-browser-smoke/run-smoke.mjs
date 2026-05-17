#!/usr/bin/env node
/**
 * Wave 2 browser smoke test runner.
 *
 * This is a thin convenience entrypoint that loads the markdown test plan
 * and tech-docs and prints them with a fresh `__STAMP__` substituted in.
 * The actual test execution happens via the Replit Agent's `runTest`
 * harness, which is invoked from the agent runtime — not from a normal
 * shell. To run the smoke test, copy the printed plan into a `runTest({
 * testPlan, relevantTechnicalDocumentation })` call from the agent JS
 * notebook (see ./README.md).
 *
 * Usage:
 *   node artifacts/api-server/src/tests/wave2-browser-smoke/run-smoke.mjs
 *
 * Output:
 *   The same plan + tech-docs that runTest expects, with __STAMP__
 *   replaced by `wave2_smoke_<unix_ms>`. Pipe to a file if you want to
 *   archive the exact text that was driven.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stamp = `wave2_smoke_${Date.now()}`;

const [plan, techDocs] = await Promise.all([
  readFile(join(here, 'test-plan.md'), 'utf8'),
  readFile(join(here, 'tech-docs.md'), 'utf8'),
]);

const stamped = (s) => s.replaceAll('__STAMP__', stamp);

const out = {
  stamp,
  testPlan: stamped(plan),
  relevantTechnicalDocumentation: stamped(techDocs),
};

process.stdout.write(JSON.stringify(out, null, 2));
process.stdout.write('\n');
