/**
 * Small hand-rolled icon set (no icon library dependency). Deliberately drafted
 * with square line caps/joins rather than round ones -- reads as technical
 * line-work instead of the soft "Feather/Lucide" default.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 15,
  height: 15,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'square' as const,
  strokeLinejoin: 'miter' as const,
};

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="9" height="9" />
      <path d="M12.8 12.8L16.5 16.5" />
    </svg>
  );
}

/** Solid disclosure triangle -- an instrument indicator, not a stroked chevron. */
export function ChevronIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className={className} {...rest}>
      <path d="M0 2l5 5 5-5z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 10.5l3.8 3.8L16 6" />
    </svg>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 3l7.5 13.5H2.5z" />
      <path d="M10 8.2v3.4" />
      <rect x="9.5" y="13.4" width="1" height="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Brand mark: a single captured waveform trace -- what the tool actually does. */
export function WaveformIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth="1.6" {...props}>
      <path d="M2 10h2.4l1.6-5.4L8.8 15 11 3.5 13 10h5" />
    </svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="7.2" y="7.2" width="5.6" height="5.6" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M16.5 12.3A6.8 6.8 0 1 1 7.7 3.5a5.4 5.4 0 0 0 8.8 8.8z" />
    </svg>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <svg {...base} viewBox="0 0 20 20" className="spin-icon" {...props}>
      <circle cx="10" cy="10" r="7.5" opacity="0.25" />
      <path d="M17.5 10a7.5 7.5 0 0 0-7.5-7.5" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </svg>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3.5" width="3" height="3" />
      <rect x="3" y="13.5" width="3" height="3" />
      <path d="M8.5 5h8.5M8.5 15h8.5M3 10h14" />
    </svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="7" y="7" width="6" height="6" />
      <path d="M10 2.5v2.2M10 15.3v2.2M17.5 10h-2.2M4.7 10H2.5M15.3 4.7l-1.6 1.6M6.3 13.7l-1.6 1.6M15.3 15.3l-1.6-1.6M6.3 6.3L4.7 4.7" />
    </svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 4h5.5a2 2 0 0 1 2 2v10a1.5 1.5 0 0 0-1.5-1.5H3z" />
      <path d="M17 4h-5.5a2 2 0 0 0-2 2v10a1.5 1.5 0 0 1 1.5-1.5H17z" />
    </svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 10s2.8-5.5 8-5.5S18 10 18 10s-2.8 5.5-8 5.5S2 10 2 10z" />
      <circle cx="10" cy="10" r="2.2" />
    </svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 10s2.8-5.5 8-5.5c1.6 0 2.9.5 4 1.2M18 10s-1 2-3 3.5M12.2 12.2a2.2 2.2 0 0 1-3.1-3.1" />
      <path d="M3 3l14 14" />
    </svg>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="4.5" width="15" height="11" />
      <path d="M2.5 5.5L10 11l7.5-5.5" />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4.5" y="9" width="11" height="8" />
      <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M3.5 17c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M17 10H3M8 4.5L3 10l5 5.5" />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="6" height="6" />
      <rect x="11" y="3" width="6" height="6" />
      <rect x="3" y="11" width="6" height="6" />
      <rect x="11" y="11" width="6" height="6" />
    </svg>
  );
}

export function TargetIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.4" />
      <circle cx="10" cy="10" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FlameIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 2.5s4 3.8 4 8a4 4 0 0 1-8 0c0-1 .4-1.8 1-2.5.2 1 .9 1.5 1.5 1.2-.6-1.8.2-3.4 1.5-4.5C9.8 5.5 9.7 4 10 2.5z" />
    </svg>
  );
}

export function BadgeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 2.5l2.2 1.3 2.6-.1 1 2.4 2.1 1.5-1 2.4 1 2.4-2.1 1.5-1 2.4-2.6-.1L10 17.5l-2.2-1.3-2.6.1-1-2.4-2.1-1.5 1-2.4-1-2.4 2.1-1.5 1-2.4 2.6.1z" />
    </svg>
  );
}
