#!/usr/bin/env node
/**
 * `pnpm sprites` — runs every job in tools/sprites.json through Blender.
 *
 * Build-time only. Nothing here is imported by the game; the game imports the
 * PNGs this writes. Sources are read from art-src/ (gitignored — see the
 * $comment in sprites.json for why the models stay off the wire).
 *
 * Needs Blender on PATH (`brew install --cask blender`). Absent, this exits
 * loud and the committed sprites are used as-is: a contributor without Blender
 * can still build and play the game, they just can't re-render props.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.SPRITE_SRC ?? join(ROOT, 'art-src');
const OUT_DIR = join(ROOT, 'client/src/art/sprites');
const BLENDER = process.env.BLENDER ?? 'blender';

const { jobs } = JSON.parse(readFileSync(join(ROOT, 'tools/sprites.json'), 'utf8'));
const only = process.argv.slice(2);
const selected = only.length ? jobs.filter((j) => only.includes(j.name)) : jobs;

if (!selected.length) {
  console.error(`no jobs matched ${JSON.stringify(only)}`);
  process.exit(1);
}

if (spawnSync(BLENDER, ['--version'], { stdio: 'ignore' }).error) {
  console.error(`blender not found (tried "${BLENDER}"). brew install --cask blender`);
  process.exit(1);
}

let failed = 0;
for (const job of selected) {
  const src = join(SRC_DIR, job.src);
  if (!existsSync(src)) {
    console.error(`✗ ${job.name}: missing source ${src}`);
    failed++;
    continue;
  }
  const args = [
    '--background',
    '--python',
    join(ROOT, 'tools/render-sprite.py'),
    '--',
    '--in',
    src,
    '--out',
    join(OUT_DIR, `${job.name}.png`),
    '--size',
    job.size,
    '--yaw',
    String(job.yaw ?? 0),
  ];
  if (job.elev !== undefined) args.push('--elev', String(job.elev));
  if (job.cuts) args.push('--cuts', job.cuts);
  if (job.ramp) args.push('--ramp', job.ramp);
  if (job.pad !== undefined) args.push('--pad', String(job.pad));
  if (job.preview) args.push('--preview', String(job.preview));

  const run = spawnSync(BLENDER, args, { encoding: 'utf8' });
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('[render-sprite]'));
  if (run.status !== 0 || !line) {
    console.error(`✗ ${job.name}\n${run.stdout ?? ''}${run.stderr ?? ''}`);
    failed++;
    continue;
  }
  console.log(line.replace('[render-sprite]', '✓').replace(`${OUT_DIR}/`, ''));
}

process.exit(failed ? 1 : 0);
