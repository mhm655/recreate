import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from './app.js';

// Real HTTP requests against a real Express app on an ephemeral port -- not a
// mocked request object -- so this exercises exactly what the browser would see,
// including JSON body parsing and status codes.
let server: Server;
let baseUrl: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsbox-ui-test-'));
  process.env.CHALLENGES_DIR = dataDir;
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dataDir, { recursive: true, force: true });
  delete process.env.CHALLENGES_DIR;
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const ORACLE = 'export function double(x: number): number { return x * 2; }';

describe('POST /api/capture', () => {
  it('rejects a request with no oracleSource', async () => {
    const res = await post('/api/capture', {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('captures a real challenge and persists it to disk', async () => {
    const res = await post('/api/capture', { oracleSource: ORACLE, seed: 1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.challenge.entryName).toBe('double');
    expect(body.challenge.tests.length).toBeGreaterThan(0);

    const saved = await fs.readFile(path.join(dataDir, `${body.challenge.id}.json`), 'utf8');
    expect(JSON.parse(saved).id).toBe(body.challenge.id);
  });

  it('runs mutation testing and reports the gate when minMutationScore is set', async () => {
    const res = await post('/api/capture', { oracleSource: ORACLE, seed: 1, minMutationScore: 0.99 });
    const body = await res.json();
    // double() scores 100% against its own generated suite (verified in the
    // harness's own test suite), so a 99% floor must still pass.
    expect(body.ok).toBe(true);
    expect(body.challenge.mutationTesting?.mutationScore).toBe(1);
  });

  it('reports a failed capture as ok:false with a reason, not a 500', async () => {
    const res = await post('/api/capture', { oracleSource: 'let n = 0;\nexport function f(): number { n += 1; return n; }' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/order-sensitive/);
  });
});

describe('GET /api/challenges and /api/challenges/:id', () => {
  it('lists a captured challenge, newest first, and can load it back by id', async () => {
    const captureRes = await post('/api/capture', { oracleSource: ORACLE, seed: 2 });
    const { challenge } = await captureRes.json();

    const listRes = await fetch(`${baseUrl}/api/challenges`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.some((c: { id: string }) => c.id === challenge.id)).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/challenges/${challenge.id}`);
    expect(getRes.status).toBe(200);
    const loaded = await getRes.json();
    expect(loaded.id).toBe(challenge.id);
    expect(loaded.entryName).toBe('double');
  });

  it('404s for an id that was never captured', async () => {
    const res = await fetch(`${baseUrl}/api/challenges/not-a-real-id`);
    expect(res.status).toBe(404);
  });

  it('404s a path-traversal id instead of reading a file outside the challenges directory', async () => {
    // Regression: loadChallenge used to join the raw route param straight onto the
    // challenges directory, so an id like '../secret' escaped it entirely. Plant a
    // real file exactly where that escape would land and confirm it is never served.
    const secretPath = path.join(dataDir, '..', 'secret.json');
    await fs.writeFile(secretPath, JSON.stringify({ leaked: true }));
    try {
      const res = await fetch(`${baseUrl}/api/challenges/${encodeURIComponent('../secret')}`);
      expect(res.status).toBe(404);
    } finally {
      await fs.rm(secretPath, { force: true });
    }
  });
});

describe('POST /api/grade', () => {
  it('grades a rewrite against a previously captured challenge, using only the saved JSON', async () => {
    const captureRes = await post('/api/capture', { oracleSource: ORACLE, seed: 3 });
    const { challenge } = await captureRes.json();

    const passRes = await post('/api/grade', { challenge, rewriteSource: 'export function double(x: number): number { return x + x; }' });
    expect(passRes.status).toBe(200);
    const passBody = await passRes.json();
    expect(passBody.verdict).toBe('passed');

    const failRes = await post('/api/grade', { challenge, rewriteSource: 'export function double(x: number): number { return x * 3; }' });
    const failBody = await failRes.json();
    expect(failBody.verdict).toBe('failed');
  });

  it('rejects a request missing rewriteSource or challenge', async () => {
    const res1 = await post('/api/grade', { challenge: { entryName: 'f' } });
    expect(res1.status).toBe(400);
    const res2 = await post('/api/grade', { rewriteSource: 'export function f() {}' });
    expect(res2.status).toBe(400);
  });
});
