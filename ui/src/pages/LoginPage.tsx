import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import AuthArt from '../components/AuthArt';
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, LockIcon, MailIcon, SpinnerIcon, WaveformIcon } from '../components/Icons';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitted(false);
    window.setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 700);
  }

  return (
    <div className="auth-screen">
      <div className="auth-screen__art">
        <AuthArt />
        <Link to="/capture" className="auth-screen__back">
          <ArrowLeftIcon /> Back to app
        </Link>
        <div className="auth-screen__art-caption">
          <span className="sidebar__mark"><WaveformIcon /></span>
          <p>Capture a function&rsquo;s behaviour. Grade every rewrite against it.</p>
        </div>
      </div>

      <div className="auth-screen__form-side">
        <div className="auth-tabs">
          <span className="auth-tab auth-tab--active">Sign in</span>
          <Link to="/signup" className="auth-tab">Sign up</Link>
        </div>

        <div className="auth-card">
          <span className="auth-eyebrow">Welcome back</span>
          <h1>Log in to ts-sandbox-harness</h1>

          <form onSubmit={onSubmit} className="auth-form">
            <label className="field">
              <span className="field__label">Email</span>
              <div className="input-icon">
                <MailIcon />
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
            </label>

            <label className="field">
              <span className="field__label">Password</span>
              <div className="input-icon">
                <LockIcon />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button type="button" className="input-icon__toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </label>

            <div className="auth-form__row">
              <a href="#" className="auth-link-inline" onClick={(e) => e.preventDefault()}>Forgot password?</a>
            </div>

            <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
              {submitting && <SpinnerIcon />}
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>

            {submitted && (
              <p className="auth-note">
                This is a UI preview -- accounts aren&rsquo;t wired up in this build yet, so nothing was actually
                submitted.
              </p>
            )}
          </form>

          <p className="auth-switch">
            Don&rsquo;t have an account? <Link to="/signup">Sign up</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
