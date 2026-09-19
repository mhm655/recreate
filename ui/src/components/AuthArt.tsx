/**
 * Ambient generative-line panel for the auth screens, in the spirit of the
 * flowing-wave sign-in art that inspired it -- rebuilt with our own brand
 * gradient and slow-drifting strokes instead of a static image. Purely
 * decorative and only ever seen on a rarely-visited screen, so a continuous
 * gentle animation is appropriate here in a way it wouldn't be on the main
 * app chrome (see the animation guidance used elsewhere in this app).
 */
const STRANDS = [
  { d: 'M-20 60 C 80 20, 160 140, 260 80 S 420 20, 520 90', delay: 0 },
  { d: 'M-20 120 C 100 180, 180 40, 280 110 S 440 180, 520 130', delay: 1.4 },
  { d: 'M-20 200 C 90 150, 200 260, 300 190 S 440 120, 520 210', delay: 0.7 },
  { d: 'M-20 280 C 110 240, 190 340, 300 290 S 430 240, 520 300', delay: 2.1 },
  { d: 'M-20 360 C 100 420, 210 300, 310 370 S 440 430, 520 380', delay: 0.3 },
];

export default function AuthArt() {
  return (
    <svg
      className="auth-art"
      viewBox="0 0 500 440"
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="authStroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="55%" stopColor="var(--brand-2)" />
          <stop offset="100%" stopColor="var(--brand-3)" />
        </linearGradient>
      </defs>
      {STRANDS.map((s, i) => (
        <path
          key={i}
          d={s.d}
          fill="none"
          stroke="url(#authStroke)"
          strokeWidth={1.4}
          strokeLinecap="round"
          className="auth-art__strand"
          style={{ animationDelay: `${s.delay}s`, opacity: 0.16 + i * 0.14 }}
        />
      ))}
    </svg>
  );
}
