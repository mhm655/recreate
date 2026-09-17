/**
 * File-based persistence for captured challenges: one JSON file per challenge,
 * named by its content-hash id. Deliberately just the filesystem -- this is a
 * local dev/demo tool, not a service with real multi-user or concurrency needs, so
 * a database would be solving a problem this tool doesn't have.
 *
 * The directory is overridable via CHALLENGES_DIR so tests can point it at a throwaway
 * temp directory instead of the real one (see server/store.test.ts).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Challenge } from 'ts-sandbox-harness';

export function challengesDir(): string {
  return process.env.CHALLENGES_DIR ?? path.join(import.meta.dirname, 'data', 'challenges');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function saveChallenge(challenge: Challenge): Promise<void> {
  const dir = challengesDir();
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, `${challenge.id}.json`), `${JSON.stringify(challenge, null, 2)}\n`, 'utf8');
}

// Every id this store hands out is a 16-char lowercase hex content hash (capture.ts's
// contentId). Enforcing that shape here -- not just trusting the caller -- closes a path
// traversal: an id built from an HTTP route param (see server/app.ts) is otherwise
// attacker-controlled, and `${id}.json` joined onto a directory happily resolves
// '../../../whatever' right out of the challenges directory.
const VALID_ID = /^[0-9a-f]{16}$/;

export async function loadChallenge(id: string): Promise<Challenge | null> {
  if (!VALID_ID.test(id)) return null;
  try {
    const raw = await fs.readFile(path.join(challengesDir(), `${id}.json`), 'utf8');
    return JSON.parse(raw) as Challenge;
  } catch {
    return null;
  }
}

export interface ChallengeSummary {
  id: string;
  entryName: string;
  testCount: number;
  droppedCount: number;
  mutationScore?: number;
  capturedAt: string;
}

function summarize(c: Challenge): ChallengeSummary {
  return {
    id: c.id,
    entryName: c.entryName,
    testCount: c.tests.length,
    droppedCount: c.droppedTestIds.length,
    mutationScore: c.mutationTesting?.mutationScore,
    capturedAt: c.capturedAt,
  };
}

/** Newest first. Skips (rather than throws on) a file that isn't valid JSON -- a corrupt entry shouldn't take the whole list down. */
export async function listChallenges(): Promise<ChallengeSummary[]> {
  const dir = challengesDir();
  await ensureDir(dir);
  const files = await fs.readdir(dir);
  const summaries: ChallengeSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      summaries.push(summarize(JSON.parse(raw) as Challenge));
    } catch {
      /* skip corrupt file */
    }
  }
  summaries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return summaries;
}
