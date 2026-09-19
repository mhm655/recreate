import { Link } from 'react-router-dom';
import type { Challenge, ChallengeGradeReport, ChallengeSummary } from '../types';
import type { Theme } from '../theme';
import CodeEditor from '../components/CodeEditor';
import RunLog from '../components/RunLog';
import VerdictBanner from '../components/VerdictBanner';
import Meter, { toneForScore } from '../components/Meter';
import { CheckIcon, ListIcon, SpinnerIcon, TargetIcon } from '../components/Icons';
import { buildGradeLog } from '../logs';

interface GradePageProps {
  challenge: Challenge | null;
  saved: ChallengeSummary[];
  loadingId: string | null;
  onLoadSaved: (id: string) => void;
  rewriteSource: string;
  setRewriteSource: (v: string) => void;
  grading: boolean;
  gradeError: string | null;
  grade: ChallengeGradeReport | null;
  theme: Theme;
  onGrade: () => void;
}

export default function GradePage({
  challenge,
  saved,
  loadingId,
  onLoadSaved,
  rewriteSource,
  setRewriteSource,
  grading,
  gradeError,
  grade,
  theme,
  onGrade,
}: GradePageProps) {
  return (
    <div className="page page--enter">
      <header className="page-header">
        <h1>Grade a rewrite</h1>
        <p className="page-sub">Run a rewrite against a captured challenge&rsquo;s fixed test suite.</p>
      </header>

      {!challenge && (
        <section className="panel panel--static">
          <div className="panel__body panel__body--pad">
            {saved.length === 0 ? (
              <p className="hint">No challenges captured yet. <Link to="/capture">Capture one first &rarr;</Link></p>
            ) : (
              <>
                <p className="panel__hint">Pick a challenge to grade against.</p>
                <div className="pick-grid">
                  {saved.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="challenge-card"
                      disabled={loadingId === s.id}
                      onClick={() => onLoadSaved(s.id)}
                    >
                      <div className="challenge-card__row">
                        <span className="challenge-card__name">{s.entryName}</span>
                      </div>
                      <code className="challenge-card__id">{s.id}</code>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {challenge && (
        <div className="split-layout split-layout--reverse">
          <div className="split-layout__main">
            <section className="panel panel--static ide-panel">
              <div className="ide-toolbar">
                <span className="ide-toolbar__tab">{challenge.entryName}.rewrite.ts</span>
                <button className="btn btn--primary btn--sm" onClick={onGrade} disabled={grading || !rewriteSource.trim()}>
                  {grading ? <SpinnerIcon /> : <CheckIcon />}
                  {grading ? 'Grading…' : 'Run grade'}
                </button>
              </div>
              <CodeEditor
                value={rewriteSource}
                onChange={setRewriteSource}
                theme={theme}
                ariaLabel="Rewrite source"
                minHeight="260px"
                maxHeight="440px"
              />
              {gradeError && <p className="error" style={{ padding: '0 1.4rem 1rem' }}>{gradeError}</p>}
              {grade && (
                <div className="panel__body panel__body--pad">
                  <RunLog lines={buildGradeLog(grade, challenge.entryName)} />
                  <VerdictBanner grade={grade} />
                </div>
              )}
            </section>
          </div>

          <aside className="split-layout__rail">
            <div className="rail-card">
              <div className="rail-card__title"><TargetIcon /> Target challenge</div>
              <div className="rail-card__challenge-name">{challenge.entryName}</div>
              <code className="id-chip">{challenge.id}</code>
              <dl className="rail-stat-list">
                <div>
                  <dt>Tests</dt>
                  <dd>{challenge.tests.length}</dd>
                </div>
                {challenge.mutationTesting?.mutationScore !== undefined && (
                  <div>
                    <dt>Mutation score</dt>
                    <dd>{(challenge.mutationTesting.mutationScore * 100).toFixed(0)}%</dd>
                  </div>
                )}
              </dl>
              <Link to="/challenges" className="rail-card__link">View full details &rarr;</Link>
            </div>

            {grade && (
              <div className="rail-card">
                <div className="rail-card__title"><ListIcon /> Result</div>
                <Meter value={grade.score} tone={toneForScore(grade.score)} size="sm" />
                <div className="rail-card__score">{(grade.score * 100).toFixed(1)}%</div>
                <div className="rail-card__sub">
                  {grade.tests.filter((t) => t.result === 'match').length}/{grade.tests.length} tests matched
                </div>
              </div>
            )}

            <Link to="/challenges" className="btn btn--ghost btn--block">Change challenge</Link>
          </aside>
        </div>
      )}
    </div>
  );
}
