#!/usr/bin/env node
// Continuous-verification wrapper. Re-runs verify_buying_scenarios.mjs
// back-to-back for 1 hour, accumulates results across all rounds.
// User asked for end-to-end testing across the full hour — single-round
// transcripts could be unlucky, multi-round gives reliable signal.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT = path.join(__dirname, 'verify_buying_scenarios.mjs');
const WRAPPER_LOG = path.join(__dirname, 'state', 'verify_loop_1hr.log');

const DURATION_MS = 60 * 60 * 1000; // 1 hour
const start = Date.now();

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  await fs.appendFile(WRAPPER_LOG, line).catch(() => {});
}

await fs.writeFile(WRAPPER_LOG, '');
await log(`1-hour verify loop start | will stop at ${new Date(start + DURATION_MS).toISOString()}`);

let round = 0;
while (Date.now() - start < DURATION_MS) {
  round += 1;
  const remainingMs = DURATION_MS - (Date.now() - start);
  await log(`=== ROUND ${round} starting (${Math.round(remainingMs / 60000)}min remaining) ===`);

  const child = spawn('node', [VERIFY_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => {
      log(`round ${round} spawn error: ${e.message}`);
      resolve(-1);
    });
  });

  await log(`=== ROUND ${round} done (exit ${exitCode}) ===`);
  // small breath between rounds to avoid hammering Supabase reconnects
  await new Promise((r) => setTimeout(r, 5000));
}

await log(`1-hour verify loop COMPLETE | rounds=${round} | duration=${Math.round((Date.now() - start) / 60000)}min`);
