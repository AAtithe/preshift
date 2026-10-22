import { useState } from 'react';
import { api, ApiError } from '../api';
import { download } from '../format';
import type { Me } from './model';

export interface AuthenticatorState {
  required: boolean;
  enrolled: boolean;
  verified: boolean;
  recoveryLeft: number;
  recoveryLow: boolean;
  lockedUntil?: string;
  configured: boolean;
  canVerify: boolean;
}

const RIGHTS = 'pay, payroll and access rights';

/**
 * What a person needs to do about their authenticator, under the header. It says what is
 * switched off and why, in the words a GM would use, and puts the fix next to it.
 */
export function AuthenticatorBar({ me }: { me: Me | null }) {
  const [enrolling, setEnrolling] = useState(false);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const a = me?.authenticator;
  if (!a || !me?.user) return null;

  async function verify() {
    setError(null);
    try {
      await api.post('/v1/me/authenticator/verify', recovery ? { recoveryCode: code } : { code });
      // The session cookie now carries the proof; reload so every screen asks again with it.
      location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check the code');
    }
  }

  async function replaceCodes() {
    try {
      setNewCodes((await api.post<{ recoveryCodes: string[] }>('/v1/me/authenticator/recovery-codes')).recoveryCodes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not make new codes');
    }
  }

  let bar: JSX.Element | null = null;
  if (a.required && !a.enrolled) {
    bar = a.configured ? (
      <div className="auth-bar bad">
        <span>Your role needs an authenticator app. Your {RIGHTS} are off until you set one up. It takes two minutes.</span>
        <button className="primary" onClick={() => setEnrolling(true)}>Set up authenticator</button>
      </div>
    ) : (
      <div className="auth-bar bad">
        <span>Your role needs an authenticator, but this server is not set up for them yet (PRESHIFT_SECRET_KEY). Ask whoever runs Preshift.</span>
      </div>
    );
  } else if (a.enrolled && !a.verified && a.canVerify) {
    bar = (
      <form className="auth-bar warn" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
        <span>
          {recovery ? 'Enter one of your recovery codes' : 'Enter the 6-digit code from your authenticator app'} to switch on your {RIGHTS} for this session.
        </span>
        <input
          className="code-input"
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          placeholder={recovery ? 'xxxx-xxxx' : '123456'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label={recovery ? 'Recovery code' : 'Authenticator code'}
        />
        <button className="primary" type="submit" disabled={!code.trim() || !!a.lockedUntil}>Confirm</button>
        <button className="link" type="button" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>
          {recovery ? 'Use the app instead' : 'Lost your phone? Use a recovery code'}
        </button>
        {error && <span className="bad-text small">{error}</span>}
      </form>
    );
  } else if (a.verified && a.recoveryLow) {
    bar = (
      <div className="auth-bar warn">
        <span>
          {a.recoveryLeft === 0
            ? 'You have no recovery codes. If you lose your phone, nobody but an administrator can let you back in. Make some now.'
            : `Only ${a.recoveryLeft} recovery ${a.recoveryLeft === 1 ? 'code' : 'codes'} left. Make new ones before you run out, or a lost phone locks you out.`}
        </span>
        <button onClick={() => void replaceCodes()}>Make new codes</button>
        {error && <span className="bad-text small">{error}</span>}
      </div>
    );
  }

  return (
    <>
      {bar}
      {enrolling && <EnrolDialog email={me.user.email} onClose={() => setEnrolling(false)} />}
      {newCodes && <RecoveryCodes codes={newCodes} email={me.user.email} onDone={() => location.reload()} />}
    </>
  );
}

/** Set up: scan the QR code (or type the key), confirm with a code, keep the recovery codes. */
export function EnrolDialog({ email, onClose }: { email: string; onClose: () => void }) {
  const [started, setStarted] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      setStarted(await api.post<{ secret: string; qrSvg: string }>('/v1/me/authenticator/start'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start');
    }
  }

  async function confirm() {
    setError(null);
    try {
      setCodes((await api.post<{ recoveryCodes: string[] }>('/v1/me/authenticator/confirm', { code })).recoveryCodes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not confirm');
    }
  }

  if (codes) return <RecoveryCodes codes={codes} email={email} onDone={() => location.reload()} />;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Set up authenticator" onClick={(e) => e.stopPropagation()}>
        <h2>Set up your authenticator</h2>
        <p className="muted small">
          An authenticator app on your phone makes a new 6-digit code every 30 seconds. Preshift asks for one each time you sign in
          before it switches on {RIGHTS}, so a stolen password alone cannot move money. Google Authenticator, Microsoft
          Authenticator, 1Password and others all work.
        </p>
        {!started ? (
          <div className="modal-actions">
            <span className="spacer" />
            <button onClick={onClose}>Not now</button>
            <button className="primary" onClick={() => void start()}>Show my QR code</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
            <ol className="enrol-steps">
              <li>In the app, add an account and scan this code.</li>
            </ol>
            {/* The SVG is made by our own server from the otpauth address, not taken from anyone else. */}
            <div className="qr" dangerouslySetInnerHTML={{ __html: started.qrSvg }} />
            <p className="muted small">Cannot scan? Type this key instead: <code className="key">{started.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
            <ol className="enrol-steps" start={2}>
              <li>Enter the 6-digit code the app now shows.</li>
            </ol>
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Code from the app"
            />
            {error && <div className="notice error">{error}</div>}
            <div className="modal-actions">
              <span className="spacer" />
              <button type="button" onClick={onClose}>Cancel</button>
              <button className="primary" type="submit" disabled={code.replace(/\s/g, '').length !== 6}>Confirm</button>
            </div>
          </form>
        )}
        {error && !started && <div className="notice error">{error}</div>}
      </div>
    </div>
  );
}

/** Shown once. The person must say they have kept them before carrying on. */
function RecoveryCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Recovery codes">
        <h2>Keep these recovery codes</h2>
        <p className="muted small">
          If you lose your phone, each of these lets you in once. They are shown now and never again: Preshift keeps only a
          fingerprint of each. Save them in your password manager or print them and keep them safe.
        </p>
        <ul className="recovery-codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <div className="modal-actions">
          <button onClick={() => download(`preshift-recovery-codes-${email}.txt`, `Preshift recovery codes for ${email}\nEach works once.\n\n${codes.join('\n')}\n`, 'text/plain')}>
            Download as a file
          </button>
          <span className="spacer" />
          <label className="check"><input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} /> I have kept them</label>
          <button className="primary" disabled={!kept} onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  );
}
