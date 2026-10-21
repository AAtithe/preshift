import { useCallback, useEffect, useRef, useState } from 'react';
import { seedState } from '../engine/seed';
import type { RotaState } from '../engine/types';
import { App, type SaveStatus } from './App';
import { Login } from './Login';
import { ApiError, getMe, loadRota, logout, saveRota, type User } from './session';

type Phase =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'ready'; user: User; state: RotaState; version: number }
  | { kind: 'error'; message: string };

const SAVE_DELAY_MS = 800;

// The signed-in product. Every read and write goes through the API, which checks the session
// cookie, so the client-side gate here is for the user's benefit, not the security boundary.
export function LiveApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const start = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const user = await getMe();
      if (!user) return setPhase({ kind: 'signedOut' });
      const { state, version } = await loadRota();
      // A new account starts from the sample sites until site set-up is built.
      setPhase({ kind: 'ready', user, state: state ?? seedState(), version });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : 'Could not load your rota.' });
    }
  }, []);

  useEffect(() => void start(), [start]);

  if (phase.kind === 'loading') return <div className="login"><p className="muted">Loading</p></div>;
  if (phase.kind === 'signedOut') return <Login onSignedIn={start} />;
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
