import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { CaptureResult, Challenge, ChallengeGradeReport, ChallengeSummary } from './types';
import { getInitialTheme, persistTheme, type Theme } from './theme';
import Sidebar from './components/Sidebar';
import { MenuIcon } from './components/Icons';
import DashboardPage from './pages/DashboardPage';
import CapturePage from './pages/CapturePage';
import ChallengesPage from './pages/ChallengesPage';
import GradePage from './pages/GradePage';
import DocsPage from './pages/DocsPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';

const EXAMPLE_ORACLE = `export function slugify(input: string, maxLength = 48): string {
  return input
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}`;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? json.reason ?? `request failed (${res.status})`);
  return json as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? json.reason ?? `request failed (${res.status})`);
  return json as T;
}

export default function App() {
  const location = useLocation();

  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  const [oracleSource, setOracleSource] = useState(EXAMPLE_ORACLE);
  const [entryName, setEntryName] = useState('');
  const [seed, setSeed] = useState('1');
  const [mutate, setMutate] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [justCaptured, setJustCaptured] = useState(false);

  const [rewriteSource, setRewriteSource] = useState('');
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [grade, setGrade] = useState<ChallengeGradeReport | null>(null);

  const [saved, setSaved] = useState<ChallengeSummary[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }, [theme]);

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  async function refreshSaved() {
    try {
      setSaved(await getJson<ChallengeSummary[]>('/api/challenges'));
      setSavedError(null);
    } catch (err) {
      setSavedError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refreshSaved();
  }, []);

  async function onLoadSaved(id: string) {
    setLoadingId(id);
    setCaptureError(null);
    setGrade(null);
    setGradeError(null);
    setRewriteSource('');
    setJustCaptured(false);
    try {
      const loaded = await getJson<Challenge>(`/api/challenges/${id}`);
      setChallenge(loaded);
      setMobileSidebarOpen(false);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingId(null);
    }
  }

  async function onCapture() {
    setCapturing(true);
    setCaptureError(null);
    setJustCaptured(false);
    setChallenge(null);
    setGrade(null);
    try {
      const result = await postJson<CaptureResult>('/api/capture', {
        oracleSource,
        entryName: entryName.trim() || undefined,
        seed: seed.trim() ? Number(seed) : undefined,
        mutate,
      });
      if (!result.ok) {
        setCaptureError(result.reason);
        return;
      }
      setChallenge(result.challenge);
      setJustCaptured(true);
      void refreshSaved();
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
    }
  }

  async function onGrade() {
    if (!challenge) return;
    setGrading(true);
    setGradeError(null);
    setGrade(null);
    try {
      const report = await postJson<ChallengeGradeReport>('/api/grade', { challenge, rewriteSource });
      setGrade(report);
    } catch (err) {
      setGradeError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(false);
    }
  }

  if (location.pathname === '/login') return <LoginPage />;
  if (location.pathname === '/signup') return <SignupPage />;

  return (
    <div className="shell">
      <Sidebar
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      <div className="workspace" ref={workspaceRef}>
        <header className="workspace__topbar">
          <button
            type="button"
            className="icon-btn workspace__menu-btn"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <MenuIcon />
          </button>
        </header>

        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage saved={saved} />} />
          <Route
            path="/capture"
            element={
              <CapturePage
                oracleSource={oracleSource}
                setOracleSource={setOracleSource}
                entryName={entryName}
                setEntryName={setEntryName}
                seed={seed}
                setSeed={setSeed}
                mutate={mutate}
                setMutate={setMutate}
                capturing={capturing}
                captureError={captureError}
                challenge={challenge}
                justCaptured={justCaptured}
                theme={theme}
                onCapture={onCapture}
              />
            }
          />
          <Route
            path="/challenges"
            element={
              <ChallengesPage
                saved={saved}
                savedError={savedError}
                loadingId={loadingId}
                challenge={challenge}
                onLoadSaved={onLoadSaved}
              />
            }
          />
          <Route
            path="/grade"
            element={
              <GradePage
                challenge={challenge}
                saved={saved}
                loadingId={loadingId}
                onLoadSaved={onLoadSaved}
                rewriteSource={rewriteSource}
                setRewriteSource={setRewriteSource}
                grading={grading}
                gradeError={gradeError}
                grade={grade}
                theme={theme}
                onGrade={onGrade}
              />
            }
          />
          <Route path="/docs" element={<DocsPage />} />
          <Route
            path="/settings"
            element={<SettingsPage theme={theme} onToggleTheme={(light) => setTheme(light ? 'light' : 'dark')} />}
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
    </div>
  );
}
