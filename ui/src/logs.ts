import type { Challenge, ChallengeGradeReport } from './types';
import type { LogLine } from './components/RunLog';

export function buildCaptureLog(challenge: Challenge): LogLine[] {
  const lines: LogLine[] = [
    { text: `capturing behaviour of ${challenge.entryName}` },
    {
      text: `${challenge.tests.length} test(s) captured${
        challenge.droppedTestIds.length > 0 ? `, ${challenge.droppedTestIds.length} dropped` : ''
      }`,
    },
  ];
  const m = challenge.mutationTesting;
  if (m) {
    lines.push({
      text: `mutation testing: ${m.killedCount} killed · ${m.survivedCount} survived · ${m.inconclusiveCount} inconclusive`,
      tone: m.survivedCount > 0 ? 'warn' : 'go',
    });
  }
  lines.push({ text: `challenge ${challenge.id} ready`, tone: 'go' });
  return lines;
}

export function buildGradeLog(grade: ChallengeGradeReport, entryName: string): LogLine[] {
  const matched = grade.tests.filter((t) => t.result === 'match').length;
  const tone = grade.verdict === 'passed' ? 'go' : grade.verdict === 'failed' ? 'stop' : 'warn';
  return [
    { text: `grading rewrite against ${entryName}` },
    { text: `${matched}/${grade.tests.length} tests matched · score ${(grade.score * 100).toFixed(1)}%` },
    { text: `verdict: ${grade.verdict.toUpperCase()}`, tone },
  ];
}
