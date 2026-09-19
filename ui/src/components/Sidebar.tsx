import type { CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import type { Theme } from '../theme';
import { BookIcon, CheckIcon, GearIcon, GridIcon, ListIcon, MoonIcon, PlusIcon, SunIcon, WaveformIcon } from './Icons';

interface SidebarProps {
  theme: Theme;
  onToggleTheme: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: GridIcon },
  { to: '/capture', label: 'Capture', icon: PlusIcon },
  { to: '/challenges', label: 'Challenges', icon: ListIcon },
  { to: '/grade', label: 'Grade', icon: CheckIcon },
  { to: '/docs', label: 'Docs', icon: BookIcon },
  { to: '/settings', label: 'Settings', icon: GearIcon },
];

export default function Sidebar({ theme, onToggleTheme, mobileOpen, onCloseMobile }: SidebarProps) {
  return (
    <>
      {mobileOpen && <div className="sidebar-scrim" onClick={onCloseMobile} />}
      <aside className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
        <NavLink to="/dashboard" className="sidebar__brand" onClick={onCloseMobile}>
          <span className="sidebar__mark"><WaveformIcon /></span>
          <div>
            <div className="sidebar__name">ts-sandbox-harness</div>
            <div className="sidebar__tag">behavior capture &amp; grading</div>
          </div>
        </NavLink>

        <nav className="nav-list" aria-label="Primary">
          {NAV_ITEMS.map(({ to, label, icon: Icon }, i) => (
            <NavLink
              key={to}
              to={to}
              onClick={onCloseMobile}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link--active' : ''}`}
              style={{ '--i': i } as CSSProperties}
            >
              <Icon className="nav-link__icon" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__auth-links">
            <NavLink to="/login" className="auth-link" onClick={onCloseMobile}>Log in</NavLink>
            <NavLink to="/signup" className="auth-link auth-link--primary" onClick={onCloseMobile}>Sign up</NavLink>
          </div>
          <div className="sidebar__footer-row">
            <span className="runner-badge" title="This UI always uses LocalRunner: no process isolation.">
              LocalRunner &middot; not isolated
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
