import type { ReactNode } from 'react';
import type { ChallengeGradeReport } from '../types';
import { describeEncoded, summarizeOutcome } from '../summarize';
import { CheckIcon, CrossIcon, WarningIcon } from './Icons';
import Meter, { type MeterTone } from './Meter';

const VERDICT_META: Record<ChallengeGradeReport['verdict'], { label: string; icon: ReactNode; tone: MeterTone; className: string }> = {
  passed: { label: 'Passed', icon: <CheckIcon />, tone: 'go', className: 'verdict--passed' },
  failed: { label: 'Failed', icon: <CrossIcon />, tone: 'stop', className: 'verdict--failed' },
  rewrite_invalid: { label: 'Rewrite invalid', icon: <WarningIcon />, tone: 'warn', className: 'verdict--invalid' },
};

export default function VerdictBanner({ grade }: { grade: ChallengeGradeReport }) {
  const meta = VERDICT_META[grade.verdict];
  const matched = grade.tests.filter((t) => t.result === 'match').length;
  const mismatches = grade.tests.filter((t) => t.result === 'mismatch');

  return (
    <div className={`verdict-banner ${meta.className}`}>
      <div className="verdict-banner__head">
        <span className="verdict-banner__icon">{meta.icon}</span>
        <div className="verdict-banner__title">
          <strong>{meta.label}</strong>
          <span className="verdict-banner__score">
            {matched}/{grade.tests.length} tests matched
          </span>
        </div>
        <div className="verdict-banner__meter">
          <Meter value={grade.score} tone={meta.tone} size="sm" />
          <span className="verdict-banner__pct">{(grade.score * 100).toFixed(1)}%</span>
        </div>
      </div>

      {grade.problems.length > 0 && (
        <ul className="problem-list">
          {grade.problems.map((p, i) => (
            <li key={i} className="problem-item">
              <WarningIcon />
              <span><code>{p.code}</code>: {p.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {mismatches.length > 0 && (
        <div className="mismatch-list">
          {mismatches.map((t) => (
            <div key={t.testId} className="mismatch-card">
              <header>
                <code className="loc-tag">{t.testId}</code>
                <span className="mismatch-reason">{t.reason}</span>
              </header>
              <div className="compare-grid">
                <div className="compare-col">
                  <span className="compare-label">Expected</span>
                  <code>{summarizeOutcome(t.expected)}</code>
                </div>
                <div className="compare-col compare-col--rewrite">
                  <span className="compare-label">Rewrite</span>
                  <code>{summarizeOutcome(t.rewrite)}</code>
                </div>
              </div>
              {t.expectedArgsAfter && t.rewriteArgsAfter && (
                <div className="compare-grid">
                  <div className="compare-col">
                    <span className="compare-label">Expected args after</span>
                    <code>{describeEncoded(t.expectedArgsAfter)}</code>
                  </div>
                  <div className="compare-col compare-col--rewrite">
                    <span className="compare-label">Rewrite args after</span>
                    <code>{describeEncoded(t.rewriteArgsAfter)}</code>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
