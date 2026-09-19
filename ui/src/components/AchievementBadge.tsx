import type { ReactNode } from 'react';

interface AchievementBadgeProps {
  icon: ReactNode;
  label: string;
  hint: string;
  unlocked: boolean;
  index?: number;
}

/** A glowing hexagonal achievement badge, unlocked or dimmed -- gamified
 * feedback for real milestones (first capture, a perfect score, and so on),
 * not decoration for its own sake. */
export default function AchievementBadge({ icon, label, hint, unlocked, index = 0 }: AchievementBadgeProps) {
  return (
    <div className="badge" data-unlocked={unlocked || undefined} style={{ animationDelay: `${index * 80}ms` }} title={hint}>
      <span className="badge__hex">{icon}</span>
      <span className="badge__label">{label}</span>
    </div>
  );
}
