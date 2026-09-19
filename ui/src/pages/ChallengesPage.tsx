import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Challenge, ChallengeSummary } from '../types';
import { summarizeOutcome } from '../summarize';
import { SearchIcon, TargetIcon } from '../components/Icons';
import MutationRing from '../components/MutationRing';
import CompositionBar from '../components/CompositionBar';
import ScoreTierDonut from '../components/ScoreTierDonut';

interface ChallengesPageProps {
  saved: ChallengeSummary[];
  savedError: string | null;
  loadingId: string | null;
  challenge: Challenge | null;
  onLoadSaved: (id: string) => void;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((then - Date.now()) / 1000);
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secs] of divisions) {
    if (Math.abs(diffSec) >= secs) return rtf.format(Math.round(diffSec / secs), unit);
  }
  return rtf.format(diffSec, 'second');
}

function tierOf(score: number | undefined): 'good' | 'mid' | 'low' | undefined {
  if (score === undefined) return undefined;
  if (score >= 0.8) return 'good';
  if (score >= 0.5) return 'mid';
  return 'low';
}

export default function ChallengesPage({ saved, savedError, loadingId, challenge, onLoadSaved }: ChallengesPageProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return saved;
    return saved.filter((s) => s.entryName.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
  }, [saved, query]);

  return (
    <div className="page page--enter">
      <header className="page-header">
        <h1>Challenges</h1>
        <p className="page-sub">Every captured behaviour, saved to disk and ready to grade a rewrite against.</p>
      </header>

      <div className="split-layout">
        <div className="split-layout__main">
          <div className="table-search">
            <SearchIcon />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or id"
              aria-label="Filter saved challenges"
            />
          </div>

          {savedError && <p className="error">{savedError}</p>}
          {!savedError && saved.length === 0 && <p className="hint">None captured yet -- head to Capture to make one.</p>}
          {!savedError && saved.length > 0 && filtered.length === 0 && <p className="hint">No matches for &ldquo;{query}&rdquo;.</p>}

          {filtered.length > 0 && (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Tests</th>
                    <th>Score</th>
                    <th>Captured</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s, i) => {
                    const isActive = s.id === challenge?.id;
                    const isLoading = loadingId === s.id;
                    const tier = tierOf(s.mutationScore);
                    return (
                      <tr
                        key={s.id}
                        className={isActive ? 'data-table__row--active' : undefined}
                        style={{ animationDelay: `${i * 35}ms` }}
                      >
                        <td>
                          <button type="button" className="row-name-btn" onClick={() => onLoadSaved(s.id)} disabled={isLoading}>
                            {s.entryName}
                          </button>
                          <code className="row-id">{s.id}</code>
                        </td>
                        <td>{s.testCount}</td>
                        <td>
                          {tier ? (
                            <span className="tier-pill" data-tier={tier}>{(s.mutationScore! * 100).toFixed(0)}%</span>
                          ) : (
                            <span className="tier-pill" data-tier="none">n/a</span>
                          )}
                        </td>
                        <td className="row-time">{isLoading ? 'Loading…' : relativeTime(s.capturedAt)}</td>
                        <td>
                          <Link to="/grade" className="row-action" onClick={() => onLoadSaved(s.id)}>
                            Grade &rarr;
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className="split-layout__rail">
          <div className="rail-card">
            <div className="rail-card__title"><TargetIcon /> Score distribution</div>
            <ScoreTierDonut saved={saved} />
          </div>
        </aside>
      </div>

      {challenge && (
        <section className="panel panel--static challenge-detail">
          <div className="panel__header-static">
            {challenge.entryName} <code className="id-chip">{challenge.id}</code>
          </div>
          <div className="panel__body panel__body--pad">
            <p className="challenge-meta-line">
              {challenge.tests.length} test{challenge.tests.length === 1 ? '' : 's'}
              {challenge.droppedTestIds.length > 0 &&
                ` · ${challenge.droppedTestIds.length} dropped (oracle couldn't answer)`}
            </p>

            <MutationRing summary={challenge.mutationTesting} />

            {challenge.mutationTesting && (
              <div className="comp-bar-wrap">
                <span className="readout__label">Composition</span>
                <CompositionBar
                  killed={challenge.mutationTesting.killedCount}
                  survived={challenge.mutationTesting.survivedCount}
                  inconclusive={challenge.mutationTesting.inconclusiveCount}
                />
              </div>
            )}

            <details className="tests-details">
              <summary>{challenge.tests.length} test{challenge.tests.length === 1 ? '' : 's'} captured</summary>
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
                      <td><code>{t.id}</code></td>
                      <td className="cell-truncate" title={summarizeOutcome(t.expected)}>
                        {summarizeOutcome(t.expected)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            <div className="panel__actions">
              <Link className="btn btn--primary" to="/grade">Grade a rewrite &rarr;</Link>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
