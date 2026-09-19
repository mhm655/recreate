import type { ChallengeSummary } from '../types';

const WEEKS = 14;
const DAY_MS = 86400000;

/** GitHub-style contribution grid, built from real capture timestamps -- how
 * many challenges were captured on each of the last ~14 weeks' days. */
export default function ActivityHeatmap({ saved }: { saved: ChallengeSummary[] }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY_MS);

  const counts = new Map<string, number>();
  for (const s of saved) {
    const d = new Date(s.capturedAt);
    d.setHours(0, 0, 0, 0);
    if (d < start) continue;
    const key = d.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());

  const days: { key: string; count: number; isToday: boolean }[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, count: counts.get(key) ?? 0, isToday: key === today.toISOString().slice(0, 10) });
  }

  function level(count: number): number {
    if (count === 0) return 0;
    const ratio = count / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  }

  return (
    <div className="heatmap">
      <div className="heatmap__grid">
        {days.map((d, i) => (
          <span
            key={d.key}
            className="heatmap__cell"
            data-level={level(d.count)}
            data-today={d.isToday || undefined}
            style={{ animationDelay: `${i * 3}ms` }}
            title={`${d.count} capture${d.count === 1 ? '' : 's'} on ${d.key}`}
          />
        ))}
      </div>
      <div className="heatmap__legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="heatmap__cell heatmap__cell--legend" data-level={l} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
