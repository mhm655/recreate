import { Link } from 'react-router-dom';
import type { ChallengeSummary } from '../types';
import StatCard from '../components/StatCard';
import ActivityHeatmap from '../components/ActivityHeatmap';
import AchievementBadge from '../components/AchievementBadge';
import ScoreTierDonut from '../components/ScoreTierDonut';
import { BadgeIcon, CheckIcon, FlameIcon, ListIcon, PlusIcon, TargetIcon } from '../components/Icons';

export default function DashboardPage({ saved }: { saved: ChallengeSummary[] }) {
  const totalTests = saved.reduce((sum, s) => sum + s.testCount, 0);
  const scored = saved.filter((s) => s.mutationScore !== undefined);
  const avgScore = scored.length > 0 ? scored.reduce((sum, s) => sum + (s.mutationScore ?? 0), 0) / scored.length : undefined;
  const perfect = saved.some((s) => s.mutationScore === 1);
  const recent = [...saved].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 4);

  return (
    <div className="page page--enter">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-sub">A quick look at what you&rsquo;ve captured and how strong it is.</p>
      </header>

      <div className="split-layout">
        <div className="split-layout__main">
          <div className="stat-grid">
            <StatCard index={0} tone="brand" icon={<ListIcon />} label="Challenges captured" value={String(saved.length)} />
            <StatCard index={1} tone="brand" icon={<TargetIcon />} label="Tests across all challenges" value={String(totalTests)} />
            <StatCard
              index={2}
              tone={avgScore !== undefined && avgScore >= 0.8 ? 'go' : 'warn'}
              icon={<CheckIcon />}
              label="Average mutation score"
              value={avgScore === undefined ? '–' : `${(avgScore * 100).toFixed(0)}%`}
            />
          </div>

          <section className="panel panel--static">
            <div className="panel__header-static">Capture activity</div>
            <div className="panel__body panel__body--pad">
              <ActivityHeatmap saved={saved} />
            </div>
          </section>

          <section className="panel panel--static">
            <div className="panel__header-static">Achievements</div>
            <div className="panel__body panel__body--pad">
              <div className="badge-row">
                <AchievementBadge
                  index={0}
                  icon={<FlameIcon />}
                  label="First capture"
                  hint="Capture your first challenge"
                  unlocked={saved.length > 0}
                />
                <AchievementBadge
                  index={1}
                  icon={<BadgeIcon />}
                  label="Perfect score"
                  hint="Reach a 100% mutation score on any challenge"
                  unlocked={perfect}
                />
                <AchievementBadge
                  index={2}
                  icon={<TargetIcon />}
                  label="Prolific"
                  hint="Capture 5 or more challenges"
                  unlocked={saved.length >= 5}
                />
              </div>
            </div>
          </section>
        </div>

        <aside className="split-layout__rail">
          <div className="rail-card">
            <div className="rail-card__title"><TargetIcon /> Score distribution</div>
            <ScoreTierDonut saved={saved} />
          </div>

          <div className="rail-card">
            <div className="rail-card__title"><ListIcon /> Recently captured</div>
            {recent.length === 0 && <p className="hint" style={{ margin: 0 }}>Nothing yet.</p>}
            <ul className="rail-recent-list">
              {recent.map((s) => (
                <li key={s.id}>
                  <span className="rail-recent-list__name">{s.entryName}</span>
                  <span className="rail-recent-list__meta">{s.testCount} tests</span>
                </li>
              ))}
            </ul>
            <Link to="/challenges" className="rail-card__link">View all &rarr;</Link>
          </div>

          <Link className="btn btn--primary btn--block" to="/capture"><PlusIcon /> New capture</Link>
        </aside>
      </div>
    </div>
  );
}
