/** A single proportional bar (killed : survived : inconclusive), each segment
 * sized by its share of the total -- composition, not score, which the Meter
 * already covers. */
interface CompositionBarProps {
  killed: number;
  survived: number;
  inconclusive: number;
}

export default function CompositionBar({ killed, survived, inconclusive }: CompositionBarProps) {
  const total = killed + survived + inconclusive;
  if (total === 0) return null;

  const segments = [
    { key: 'killed', count: killed, tone: 'go' },
    { key: 'survived', count: survived, tone: 'warn' },
    { key: 'inconclusive', count: inconclusive, tone: 'flat' },
  ].filter((s) => s.count > 0);

  return (
    <div className="comp-bar" role="img" aria-label={`${killed} killed, ${survived} survived, ${inconclusive} inconclusive`}>
      {segments.map((s) => (
        <span
          key={s.key}
          className="comp-bar__seg"
          data-tone={s.tone}
          style={{ flexGrow: s.count / total }}
        />
      ))}
    </div>
  );
}
