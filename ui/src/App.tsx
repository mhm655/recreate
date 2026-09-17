import { useState } from 'react';
import type { CaptureResult, Challenge, ChallengeGradeReport, Outcome } from './types';

const EXAMPLE_ORACLE = `export function slugify(input: string, maxLength = 48): string {
  return input
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}`;

function summarizeOutcome(o: Outcome): string {
  switch (o.type) {
    case 'return':
      return `returned ${JSON.stringify(o.value)}`;
    case 'thrown':
      return `threw ${o.errorClass}: ${o.message}`;
    case 'timeout':
      return `timed out after ${o.limitMs}ms`;
    case 'resource_limit':
      return `resource limit (${o.limit}): ${o.detail}`;
    case 'harness_error':
      return `harness error: ${o.detail}`;
    default:
      return 'unknown outcome';
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? json.reason ?? `request failed (${res.status})`);
  return json as T;
}

function MutationSummary({ summary }: { summary: Challenge['mutationTesting'] }) {
  if (!summary) return null;
  const scoreable = summary.killedCount + summary.survivedCount;
  return (
    <div className="mutation-summary">
      <strong>Mutation score:</strong>{' '}
      {summary.mutationScore === undefined ? 'n/a' : `${(summary.mutationScore * 100).toFixed(1)}%`}
      {' '}({summary.killedCount} killed / {scoreable} scoreable, {summary.inconclusiveCount} inconclusive)
      {summary.survived.length > 0 && (
        <ul className="survived-list">
          {summary.survived.map((s, i) => (
            <li key={i}>
              SURVIVED (line {s.line}:{s.column}): {s.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [oracleSource, setOracleSource] = useState(EXAMPLE_ORACLE);
  const [entryName, setEntryName] = useState('');
  const [seed, setSeed] = useState('1');
  const [mutate, setMutate] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);

  const [rewriteSource, setRewriteSource] = useState('');
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [grade, setGrade] = useState<ChallengeGradeReport | null>(null);

  async function onCapture() {
    setCapturing(true);
    setCaptureError(null);
    setChallenge(null);
    setGrade(null);
    try {
      const result = await postJson<CaptureResult>('/api/capture', {
        oracleSource,
        entryName: entryName.trim() || undefined,
        seed: seed.trim() ? Number(seed) : undefined,
        mutate,
      });
      if (!result.ok) {
        setCaptureError(result.reason);
        return;
      }
      setChallenge(result.challenge);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }

  async function onGrade() {
    if (!challenge) return;
    setGrading(true);
    setGradeError(null);
    setGrade(null);
    try {
      const report = await postJson<ChallengeGradeReport>('/api/grade', { challenge, rewriteSource });
      setGrade(report);
    } catch (err) {
      setGradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>ts-sandbox-harness</h1>
        <p className="subtitle">
          Capture a function's behaviour as a fixed Challenge, then grade a rewrite against it. Runs against{' '}
          <strong>LocalRunner (not isolated)</strong> -- a local dev tool, not a place to grade untrusted code for real.
        </p>
      </header>

      <section className="card">
        <h2>1. Capture a challenge</h2>
        <label>
          Oracle source (TypeScript)
          <textarea rows={10} value={oracleSource} onChange={(e) => setOracleSource(e.target.value)} spellCheck={false} />
        </label>
        <div className="row">
          <label>
            Entry name (optional)
            <input value={entryName} onChange={(e) => setEntryName(e.target.value)} placeholder="inferred" />
          </label>
          <label>
            Seed
            <input value={seed} onChange={(e) => setSeed(e.target.value)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={mutate} onChange={(e) => setMutate(e.target.checked)} />
            Run mutation testing
          </label>
        </div>
        <button onClick={onCapture} disabled={capturing || !oracleSource.trim()}>
          {capturing ? 'Capturing...' : 'Capture challenge'}
        </button>
        {captureError && <p className="error">{captureError}</p>}

        {challenge && (
          <div className="result">
            <p>
              Challenge <code>{challenge.id}</code> for <code>{challenge.entryName}</code> -- {challenge.tests.length} test(s)
              {challenge.droppedTestIds.length > 0 && `, ${challenge.droppedTestIds.length} dropped (oracle timed out)`}
            </p>
            <MutationSummary summary={challenge.mutationTesting} />
            <details>
              <summary>{challenge.tests.length} test(s) captured</summary>
              <table>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>expected</th>
                  </tr>
                </thead>
                <tbody>
                  {challenge.tests.map((t) => (
                    <tr key={t.id}>
                      <td>{t.id}</td>
                      <td>{summarizeOutcome(t.expected)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </section>

      <section className="card">
        <h2>2. Grade a rewrite</h2>
        {!challenge && <p className="hint">Capture a challenge above first.</p>}
        <label>
          Rewrite source (TypeScript)
          <textarea
            rows={10}
            value={rewriteSource}
            onChange={(e) => setRewriteSource(e.target.value)}
            spellCheck={false}
            disabled={!challenge}
          />
        </label>
        <button onClick={onGrade} disabled={!challenge || grading || !rewriteSource.trim()}>
          {grading ? 'Grading...' : 'Grade'}
        </button>
        {gradeError && <p className="error">{gradeError}</p>}

        {grade && (
          <div className={`result verdict-${grade.verdict}`}>
            <p>
              <strong>{grade.verdict.toUpperCase()}</strong> -- score{' '}
              {(grade.score * 100).toFixed(1)}% ({grade.tests.filter((t) => t.result === 'match').length}/{grade.tests.length})
            </p>
            {grade.problems.map((p, i) => (
              <p key={i} className="problem">
                ! {p.code}: {p.detail}
              </p>
            ))}
            {grade.tests
              .filter((t) => t.result === 'mismatch')
              .map((t) => (
                <div key={t.testId} className="mismatch">
                  <strong>{t.testId}</strong>: {t.reason}
                  <div className="mismatch-detail">
                    <div>expected: {summarizeOutcome(t.expected)}</div>
                    <div>rewrite: {summarizeOutcome(t.rewrite)}</div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
