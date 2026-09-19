import type { Theme } from '../theme';
import Toggle from '../components/Toggle';

interface SettingsPageProps {
  theme: Theme;
  onToggleTheme: (v: boolean) => void;
}

export default function SettingsPage({ theme, onToggleTheme }: SettingsPageProps) {
  return (
    <div className="page page--enter">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="page-sub">Local to this browser -- nothing here is sent anywhere.</p>
      </header>

      <section className="panel panel--static">
        <div className="panel__header-static">Appearance</div>
        <div className="panel__body panel__body--pad">
          <Toggle
            id="theme-toggle-settings"
            checked={theme === 'light'}
            onChange={onToggleTheme}
            label={theme === 'light' ? 'Light theme' : 'Dark theme'}
          />
        </div>
      </section>

      <section className="panel panel--static">
        <div className="panel__header-static">Runner</div>
        <div className="panel__body panel__body--pad docs-body">
          <p>
            <span className="runner-badge">LocalRunner &middot; not isolated</span>
          </p>
          <p className="page-sub" style={{ margin: '0.75rem 0 0' }}>
            This dev server always grades through LocalRunner. See the Docs tab for what that means.
          </p>
        </div>
      </section>
    </div>
  );
}
