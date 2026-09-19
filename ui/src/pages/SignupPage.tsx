import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import AuthArt from '../components/AuthArt';
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, LockIcon, MailIcon, SpinnerIcon, UserIcon, WaveformIcon } from '../components/Icons';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
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
          <Link to="/login" className="auth-tab">Sign in</Link>
          <span className="auth-tab auth-tab--active">Sign up</span>
        </div>

        <div className="auth-card">
          <span className="auth-eyebrow">Welcome</span>
          <h1>Create your account</h1>

          <form onSubmit={onSubmit} className="auth-form">
            <label className="field">
              <span className="field__label">Name</span>
              <div className="input-icon">
                <UserIcon />
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
              </div>
            </label>

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
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <button type="button" className="input-icon__toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </label>

            <label className="checkbox-row">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />
              I agree to the terms of the service
            </label>

            <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
              {submitting && <SpinnerIcon />}
              {submitting ? 'Creating account…' : 'Create account'}
            </button>

            {submitted && (
              <p className="auth-note">
                This is a UI preview -- accounts aren&rsquo;t wired up in this build yet, so nothing was actually
                created.
              </p>
            )}
          </form>

          <p className="auth-switch">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
