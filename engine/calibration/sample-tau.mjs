#!/usr/bin/env node
// Draws the Track A sample from a tau-bench checkout and prints the manifest (ids + hashes) for pre-registration.
// Usage: node calibration/sample-tau.mjs <tau-bench>/historical_trajectories [seed]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapt, sample } from './tau.js';

const [dir, seedArg] = process.argv.slice(2);
if (!dir) { console.error('usage: sample-tau.mjs <historical_trajectories dir> [seed]'); process.exit(2); }
const seed = Number(seedArg ?? 20261021);
const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const items = [], fileHashes = {};
for (const f of files) {
  const raw = readFileSync(join(dir, f));
  fileHashes[f] = createHash('sha256').update(raw).digest('hex');
  for (const t of JSON.parse(raw)) items.push(adapt(f, t));
}
const s = sample(items, { seed, perStratum: { dev: 8, test: 30 } });
process.stdout.write(JSON.stringify({ source: 'sierra-research/tau-bench historical_trajectories', fileHashes, seed, devGroupShare: 0.2, perStratum: { dev: 8, test: 30 }, sampleHash: s.hash, dev: s.dev, test: s.test }, null, 1) + '\n');
