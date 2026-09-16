/**
 * Run the analyzer in a worker thread with a wall-clock timeout and a heap cap.
 *
 * Analysis never executes the source, so this is not about code execution. It is
 * about the type checker itself: TypeScript's type system is Turing-complete, and a
 * hostile source can make the checker instantiate types until it exhausts memory or
 * time. Anything analysing sources it did not write should go through here, so the
 * worst case is a clean `analysis-timeout` rather than a wedged host process.
 *
 * As in the sandbox harness, the worker thread is the interruption mechanism, not a
 * security boundary.
 */

import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { AnalyzeOptions } from './analyze';
import type { AnalysisResult } from './types';

export interface IsolationLimits {
  timeoutMs: number;
  maxHeapMb: number;
}

export const DEFAULT_ISOLATION_LIMITS: IsolationLimits = { timeoutMs: 15_000, maxHeapMb: 512 };

export function analyzeIsolated(
  source: string,
  options: AnalyzeOptions = {},
  limits: Partial<IsolationLimits> = {},
): Promise<AnalysisResult> {
  const { timeoutMs, maxHeapMb } = { ...DEFAULT_ISOLATION_LIMITS, ...limits };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AnalysisResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const fail = (code: string, message: string) => finish({ ok: false, errors: [{ code, message }] });

    const worker = new Worker(path.join(__dirname, 'analyze-worker.js'), {
      workerData: { source, options },
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    });
    const timer = setTimeout(
      () => fail('analysis-timeout', `type analysis exceeded ${timeoutMs}ms and was terminated`),
      timeoutMs,
    );

    worker.on('message', (result: AnalysisResult) => finish(result));
    worker.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? fail('analysis-out-of-memory', `type analysis exceeded ${maxHeapMb}MB and was terminated`)
        : fail('analysis-crashed', err.message),
    );
    worker.on('exit', (code) => fail('analysis-crashed', `analysis worker exited with code ${code}`));
  });
}
