import type { ChallengeSummary } from '../types';

const R = 42;
const CIRC = 2 * Math.PI * R;

/** Donut breakdown of how many captured challenges land in each mutation-score
 * tier -- the aggregate view the per-challenge meter can't show on its own. */
export default function ScoreTierDonut({ saved }: { saved: ChallengeSummary[] }) {
  const scored = saved.filter((s) => s.mutationScore !== undefined);
  const good = scored.filter((s) => s.mutationScore! >= 0.8).length;
  const mid = scored.filter((s) => s.mutationScore! >= 0.5 && s.mutationScore! < 0.8).length;
  const low = scored.length - good - mid;
  const total = scored.length;

  const segments = [
    { count: good, tone: 'go' },
    { count: mid, tone: 'warn' },
    { count: low, tone: 'stop' },
  ].filter((s) => s.count > 0);

  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = total > 0 ? s.count / total : 0;
    const dash = frac * CIRC;
    const arc = { ...s, dash, offset };
    offset += dash;
    return arc;
  });

  return (
    <div className="tier-donut">
      <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={`${good} good, ${mid} mid, ${low} low scoring challenges`}>
        <circle cx="56" cy="56" r={R} className="tier-donut__track" />
        {total === 0 ? null : arcs.map((a, i) => (
          <circle
            key={i}
            cx="56"
            cy="56"
            r={R}
            className="tier-donut__arc"
            data-tone={a.tone}
            style={{
              strokeDasharray: `${a.dash} ${CIRC - a.dash}`,
              strokeDashoffset: -a.offset,
            }}
          />
        ))}
        <text x="56" y="52" textAnchor="middle" className="tier-donut__num">{total}</text>
        <text x="56" y="68" textAnchor="middle" className="tier-donut__label">scored</text>
      </svg>
      <ul className="tier-donut__legend">
        <li data-tone="go"><span /> Strong (&ge;80%) <strong>{good}</strong></li>
        <li data-tone="warn"><span /> Mid (50&ndash;79%) <strong>{mid}</strong></li>
        <li data-tone="stop"><span /> Weak (&lt;50%) <strong>{low}</strong></li>
      </ul>
    </div>
  );
}
