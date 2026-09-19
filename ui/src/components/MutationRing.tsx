import type { Challenge } from '../types';
import Meter, { toneForScore } from './Meter';

export default function MutationRing({ summary }: { summary: Challenge['mutationTesting'] }) {
  if (!summary) {
    return (
      <div className="readout readout--empty">
        No mutation testing was run for this capture.
      </div>
    );
  }

  const { killedCount, survivedCount, inconclusiveCount, mutationScore, survived } = summary;
  const scoreable = killedCount + survivedCount;
  const tone = mutationScore !== undefined ? toneForScore(mutationScore) : 'flat';

  return (
    <div className="readout">
      <div className="readout__head">
        <span className="readout__label">Mutation score</span>
        <span className="readout__value" data-tone={tone}>
          {mutationScore === undefined ? 'N/A' : `${(mutationScore * 100).toFixed(1)}%`}
        </span>
      </div>
      <Meter value={mutationScore} tone={tone} />

      <dl className="readout__stats">
        <div className="readout__stat">
          <dt data-tone="go">Killed</dt>
          <dd>{killedCount}</dd>
        </div>
        <div className="readout__stat">
          <dt data-tone="warn">Survived</dt>
          <dd>{survivedCount}</dd>
        </div>
        <div className="readout__stat">
          <dt data-tone="flat">Inconclusive</dt>
          <dd>{inconclusiveCount}</dd>
        </div>
        <div className="readout__stat readout__stat--muted">
          <dt>Scoreable</dt>
          <dd>{scoreable}</dd>
        </div>
      </dl>

      {survived.length > 0 && (
        <details className="survived-details">
          <summary>{survived.length} mutant{survived.length === 1 ? '' : 's'} survived</summary>
          <ul className="survived-list">
            {survived.map((s, i) => (
              <li key={i}>
                <code className="loc-tag">{s.line}:{s.column}</code>
                {s.description}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
