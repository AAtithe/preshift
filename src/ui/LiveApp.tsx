import { useCallback, useEffect, useRef, useState } from 'react';
import { applySetup, emptyDraft } from '../engine/setup';
import type { RotaState } from '../engine/types';
import { App, type SaveStatus } from './App';
import { ChangePassword } from './ChangePassword';
import { Login } from './Login';
import { ResetPassword } from './ResetPassword';
import { Setup } from './Setup';
import { ApiError, getMe, loadRota, logout, saveRota, type User } from './session';

type Phase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'changePassword'; user: User }
  | { kind: 'setup'; user: User }
  | { kind: 'ready'; user: User; state: RotaState; version: number }
  | { kind: 'error'; message: string };

const SAVE_DELAY_MS = 800;

// A reset link carries its token in the fragment. Read it once, then drop it from the address bar
// so it does not sit in history or get copied into a screenshot.
function takeResetToken(): string | null {
  if (!window.location.pathname.endsWith('/reset')) return null;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  history.replaceState(null, '', window.location.pathname);
  return token;
}

// Module scope, not a state initialiser: React may run initialisers twice, and the first run
// has already cleared the fragment.
const initialResetToken = takeResetToken();

// The signed-in product. Every read and write goes through the API, which checks the session
// cookie, so the client-side gate here is for the user's benefit, not the security boundary.
export function LiveApp() {
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const start = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const user = await getMe();
      if (!user) return setPhase({ kind: 'signedOut' });
      if (user.mustChangePassword) return setPhase({ kind: 'changePassword', user });
      const { state, version } = await loadRota();
      setPhase(state ? { kind: 'ready', user, state, version } : { kind: 'setup', user });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load your rota.' });
    }
  }, []);

  useEffect(() => {
    if (!resetToken) void start();
  }, [start, resetToken]);

  if (resetToken || window.location.pathname.endsWith('/reset')) {
    return (
      <ResetPassword
        token={resetToken ?? ''}
        onDone={() => {
          history.replaceState(null, '', window.location.pathname.replace(/reset$/, ''));
          setResetToken(null);
        }}
      />
    );
  }

  if (phase.kind === 'loading') return <div className="login"><p className="muted">Loading</p></div>;
  if (phase.kind === 'signedOut') return <Login onSignedIn={start} />;
  if (phase.kind === 'changePassword') {
    return <ChangePassword user={phase.user} forced onDone={start} />;
  }
  if (phase.kind === 'setup') {
    const { user } = phase;
    return (
      <div className="app">
        <Setup
          initial={emptyDraft()}
          prev={null}
          onFinish={async (draft) => {
            const state = applySetup(null, draft);
            // Version 0 is a first save; a 409 means a colleague finished set-up first.
            const { version } = await saveRota(state, 0);
            setPhase({ kind: 'ready', user, state, version });
          }}
        />
      </div>
    );
  }
  if (phase.kind === 'error') {
    return (
      <div className="login">
        <div className="login-card">
          <p className="login-error">{phase.message}</p>
          <button onClick={start}>Try again</button>
        </div>
      </div>
    );
  }
  return <Synced key={phase.user.id} user={phase.user} initial={phase.state} version={phase.version} onSignedOut={() => setPhase({ kind: 'signedOut' })} />;
}

function Synced(props: { user: User; initial: RotaState; version: number; onSignedOut: () => void }) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'saved' });
  const version = useRef(props.version);
  const pending = useRef<RotaState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef(false);
  const { onSignedOut } = props;

  const flush = useCallback(async () => {
    if (inFlight.current || !pending.current) return;
    const state = pending.current;
    pending.current = null;
    inFlight.current = true;
    setStatus({ kind: 'saving' });
    try {
      version.current = (await saveRota(state, version.current)).version;
      setStatus(pending.current ? { kind: 'saving' } : { kind: 'saved' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSignedOut();
      // On a conflict, stop saving: overwriting would lose a colleague's work.
      const conflict = err instanceof ApiError && err.status === 409;
      if (!conflict) pending.current ??= state;
      setStatus({ kind: 'failed', message: err instanceof Error ? err.message : 'Save failed.', conflict });
    } finally {
      inFlight.current = false;
    }
    if (pending.current) timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [onSignedOut]);

  const persist = useCallback(
    (state: RotaState) => {
      pending.current = state;
      setStatus({ kind: 'saving' });
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current || inFlight.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  async function signOut() {
    await logout().catch(() => undefined);
    onSignedOut();
  }

  return (
    <App
      mode="live"
      initial={props.initial}
      persist={persist}
      user={props.user}
      saveStatus={status}
      onSignOut={signOut}
    />
  );
}
