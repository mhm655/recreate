import type { ReactNode } from 'react';

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: 'brand' | 'go' | 'warn';
  index?: number;
}

export default function StatCard({ icon, label, value, tone = 'brand', index = 0 }: StatCardProps) {
  return (
    <div className="stat-card" style={{ animationDelay: `${index * 60}ms` }}>
      <span className="stat-card__icon" data-tone={tone}>{icon}</span>
      <div>
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
      </div>
    </div>
  );
}
