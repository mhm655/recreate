/**
 * Persistence for captured challenges: one JSON object per challenge, named by its
 * content-hash id. Two backends, chosen automatically:
 *
 * - Local disk (`server/data/challenges/<id>.json`) when `BLOB_READ_WRITE_TOKEN` is
 *   unset -- `npm run dev` and the test suite (server/app.test.ts, via CHALLENGES_DIR).
 *   Deliberately just the filesystem: this is a local dev/demo tool, not a service
 *   with real multi-user or concurrency needs, so a database would be solving a
 *   problem this tool doesn't have.
 * - Vercel Blob when that token is present -- a Vercel deployment's functions don't
 *   have a persistent, shared filesystem, so captures need to live somewhere outside
 *   the function instance itself. Challenge data (function names, generated inputs,
 *   captured outputs) isn't sensitive, so blobs are stored with public access rather
 *   than adding the extra complexity of signed private reads.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { list, put } from '@vercel/blob';
import type { Challenge } from 'ts-sandbox-harness';

const usingBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_PREFIX = 'challenges/';

export function challengesDir(): string {
  return process.env.CHALLENGES_DIR ?? path.join(import.meta.dirname, 'data', 'challenges');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// Every id this store hands out is a 16-char lowercase hex content hash (capture.ts's
// contentId). Enforcing that shape here -- not just trusting the caller -- closes a path
// traversal on the local-disk backend: an id built from an HTTP route param (see
// server/app.ts) is otherwise attacker-controlled, and `${id}.json` joined onto a
// directory happily resolves '../../../whatever' right out of the challenges directory.
const VALID_ID = /^[0-9a-f]{16}$/;

export async function saveChallenge(challenge: Challenge): Promise<void> {
  if (usingBlob) {
    await put(`${BLOB_PREFIX}${challenge.id}.json`, `${JSON.stringify(challenge, null, 2)}\n`, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return;
  }
  const dir = challengesDir();
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, `${challenge.id}.json`), `${JSON.stringify(challenge, null, 2)}\n`, 'utf8');
}

export async function loadChallenge(id: string): Promise<Challenge | null> {
  if (!VALID_ID.test(id)) return null;
  if (usingBlob) {
    const { blobs } = await list({ prefix: `${BLOB_PREFIX}${id}.json`, limit: 1 });
    const match = blobs.find((b) => b.pathname === `${BLOB_PREFIX}${id}.json`);
    if (!match) return null;
    try {
      const res = await fetch(match.url);
      if (!res.ok) return null;
      return (await res.json()) as Challenge;
    } catch {
      return null;
    }
  }
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

/** Newest first. Skips (rather than throws on) an entry that isn't valid JSON -- a corrupt entry shouldn't take the whole list down. */
export async function listChallenges(): Promise<ChallengeSummary[]> {
  const summaries: ChallengeSummary[] = [];
  if (usingBlob) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: BLOB_PREFIX, cursor });
      for (const b of page.blobs) {
        try {
          const res = await fetch(b.url);
          if (!res.ok) continue;
          summaries.push(summarize((await res.json()) as Challenge));
        } catch {
          /* skip corrupt blob */
        }
      }
      cursor = page.cursor;
    } while (cursor);
  } else {
    const dir = challengesDir();
    await ensureDir(dir);
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        summaries.push(summarize(JSON.parse(raw) as Challenge));
      } catch {
        /* skip corrupt file */
      }
    }
  }
  summaries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return summaries;
}
