/**
 * A segmented signal-strength readout -- ticks fill left to right, like a VU meter
 * or a signal bar, instead of the generic rounded progress bar/ring. Used for both
 * the mutation score and the grade score so the two "how strong is this" numbers
 * share one visual language.
 */
const SEGMENTS = 24;

export type MeterTone = 'go' | 'warn' | 'stop' | 'flat';

export function toneForScore(score: number): MeterTone {
  if (score >= 0.8) return 'go';
  if (score >= 0.5) return 'warn';
  return 'stop';
}

interface MeterProps {
  value: number | undefined;
  tone: MeterTone;
  size?: 'sm' | 'lg';
}

export default function Meter({ value, tone, size = 'lg' }: MeterProps) {
  const filled = value === undefined ? 0 : Math.round(value * SEGMENTS);
  return (
    <div className={`meter meter--${size}`} data-tone={tone} role="img" aria-label={value === undefined ? 'not available' : `${(value * 100).toFixed(0)} percent`}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="meter__seg"
          data-lit={i < filled || undefined}
          style={{ transitionDelay: i < filled ? `${i * 14}ms` : '0ms' }}
        />
      ))}
    </div>
  );
}
