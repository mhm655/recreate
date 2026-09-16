/** Worker-thread entry for analyzeIsolated. See ./isolated.ts. */

import { parentPort, workerData } from 'node:worker_threads';

import { analyzeFunction, type AnalyzeOptions } from './analyze';
import type { AnalysisResult } from './types';

const { source, options } = workerData as { source: string; options: AnalyzeOptions };

let result: AnalysisResult;
try {
  result = analyzeFunction(source, options);
} catch (err) {
  result = { ok: false, errors: [{ code: 'analysis-crashed', message: err instanceof Error ? err.message : String(err) }] };
}
parentPort?.postMessage(result);
