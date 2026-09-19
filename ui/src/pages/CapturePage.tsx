import { Link } from 'react-router-dom';
import type { Challenge } from '../types';
import type { Theme } from '../theme';
import CodeEditor from '../components/CodeEditor';
import Toggle from '../components/Toggle';
import RunLog from '../components/RunLog';
import { BookIcon, SpinnerIcon, TargetIcon } from '../components/Icons';
import { buildCaptureLog } from '../logs';

interface CapturePageProps {
  oracleSource: string;
  setOracleSource: (v: string) => void;
  entryName: string;
  setEntryName: (v: string) => void;
  seed: string;
  setSeed: (v: string) => void;
  mutate: boolean;
  setMutate: (v: boolean) => void;
  capturing: boolean;
  captureError: string | null;
  challenge: Challenge | null;
  justCaptured: boolean;
  theme: Theme;
  onCapture: () => void;
}

export default function CapturePage({
  oracleSource,
  setOracleSource,
  entryName,
  setEntryName,
  seed,
  setSeed,
  mutate,
  setMutate,
  capturing,
  captureError,
  challenge,
  justCaptured,
  theme,
  onCapture,
}: CapturePageProps) {
  return (
    <div className="page page--enter">
      <header className="page-header">
        <h1>Capture a challenge</h1>
        <p className="page-sub">
          Paste a function, capture its behaviour as a fixed test suite, and optionally measure how strong that
          suite is with mutation testing.
        </p>
      </header>

      <div className="split-layout">
        <div className="split-layout__main">
          <section className="panel panel--static ide-panel">
            <div className="ide-toolbar">
              <span className="ide-toolbar__tab">oracle.ts</span>
              <button className="btn btn--primary btn--sm" onClick={onCapture} disabled={capturing || !oracleSource.trim()}>
                {capturing ? <SpinnerIcon /> : <TargetIcon />}
                {capturing ? 'Capturing…' : 'Capture'}
              </button>
            </div>
            <CodeEditor value={oracleSource} onChange={setOracleSource} theme={theme} ariaLabel="Oracle source" minHeight="260px" maxHeight="440px" />

            <div className="panel__body panel__body--pad">
              <div className="config-row">
                <label className="field field--compact">
                  <span className="field__label">Entry name</span>
                  <input value={entryName} onChange={(e) => setEntryName(e.target.value)} placeholder="inferred" />
                </label>
                <label className="field field--compact">
                  <span className="field__label">Seed</span>
                  <input value={seed} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" />
                </label>
                <Toggle id="mutate-toggle" checked={mutate} onChange={setMutate} label="Run mutation testing" />
              </div>
              {captureError && <p className="error">{captureError}</p>}

              {justCaptured && challenge && (
                <div className="panel--celebrate">
                  <RunLog lines={buildCaptureLog(challenge)} />
                  <div className="next-steps">
                    <Link className="btn btn--ghost" to="/challenges">View challenge details</Link>
                    <Link className="btn btn--primary" to="/grade">Grade a rewrite &rarr;</Link>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="split-layout__rail">
          <div className="rail-card">
            <div className="rail-card__title"><BookIcon /> What makes a good oracle</div>
            <ul className="tips-list">
              <li>Export the function you want to capture -- the harness infers the entry point.</li>
              <li>Keep it deterministic: no <code>Date.now()</code>, randomness, or network calls.</li>
              <li>Give it a real spread of inputs to shine -- edge cases like empty strings and negative numbers get generated automatically.</li>
              <li>Mutation testing tells you if your captured tests would actually catch a bug -- worth leaving on.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
