/**
 * Thin API layer over ts-sandbox-harness. Runs on real Node (fs, worker_threads,
 * child processes) -- none of which belongs in browser code, which is why this is
 * a separate server rather than something Vite bundles into the client.
 *
 * Uses LocalRunner unconditionally: this is a local dev/demo tool, and LocalRunner
 * is the only runner that works without a Linux host with gVisor registered (see
 * the harness's own README). Every response says so via `runner.isolated`, and the
 * client surfaces it -- this UI is not, and should not be treated as, a place to
 * grade untrusted submissions for real.
 *
 * Exports the configured app without listening, so tests (server/app.test.ts) can
 * start it on an ephemeral port instead of the fixed one index.ts uses.
 */

import express from 'express';
import {
  captureChallenge,
  gradeAgainstChallenge,
  LocalRunner,
  type Challenge,
} from 'ts-sandbox-harness';
import { listChallenges, loadChallenge, saveChallenge } from './store.js';

const LIMITS = {
  perTestTimeoutMs: 1_000,
  passTimeoutMs: 15_000,
  submissionTimeoutMs: 60_000,
};

function runner() {
  return new LocalRunner();
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/api/capture', async (req, res) => {
    const { oracleSource, entryName, seed, maxTests, mutate, minMutationScore } = req.body as {
      oracleSource?: string;
      entryName?: string;
      seed?: number;
      maxTests?: number;
      mutate?: boolean;
      minMutationScore?: number;
    };
    if (typeof oracleSource !== 'string' || !oracleSource.trim()) {
      res.status(400).json({ ok: false, reason: 'oracleSource is required' });
      return;
    }

    try {
      const result = await captureChallenge({
        oracleSource,
        entryName: entryName || undefined,
        seed: typeof seed === 'number' ? seed : undefined,
        maxTests: typeof maxTests === 'number' ? maxTests : undefined,
        mutationTest: mutate ? true : false,
        minMutationScore: typeof minMutationScore === 'number' ? minMutationScore : undefined,
        runner: runner(),
        limits: LIMITS,
      });
      if (result.ok) {
        // Persistence is a convenience, not the primary result: a save failure is
        // logged and otherwise ignored so the client still gets the challenge it
        // just captured, in memory, either way.
        try {
          await saveChallenge(result.challenge);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('failed to save captured challenge:', err);
        }
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/challenges', async (_req, res) => {
    try {
      res.json(await listChallenges());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/challenges/:id', async (req, res) => {
    try {
      const challenge = await loadChallenge(req.params.id);
      if (!challenge) {
        res.status(404).json({ error: `no saved challenge with id '${req.params.id}'` });
        return;
      }
      res.json(challenge);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/grade', async (req, res) => {
    const { challenge, rewriteSource } = req.body as { challenge?: Challenge; rewriteSource?: string };
    if (!challenge || typeof challenge !== 'object') {
      res.status(400).json({ error: 'challenge is required' });
      return;
    }
    if (typeof rewriteSource !== 'string' || !rewriteSource.trim()) {
      res.status(400).json({ error: 'rewriteSource is required' });
      return;
    }

    try {
      const report = await gradeAgainstChallenge(challenge, {
        rewriteSource,
        runner: runner(),
        limits: LIMITS,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}
