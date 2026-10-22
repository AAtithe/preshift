import type { RotaState } from '../../../src/engine/types';
import type { UserStore } from '../../store';
import { saveCredentials, type EposCredentials } from './credentials';
import { LightspeedProvider, type LightspeedApp } from './lightspeed';
import { EposError, type EposConnection, type EposProvider } from './provider';
import { TillSimulator } from './simulator';
import { SquareProvider } from './square';
import { ToastProvider } from './toast';

export interface ProviderDeps {
  store: UserStore;
  orgId: string;
  state: Pick<RotaState, 'sites' | 'forecast'>;
  fetch: typeof fetch;
  /** Preshift's Lightspeed app, when the server has one. */
  lightspeedApp?: LightspeedApp;
}

/** The till an organisation has connected, signed in with the credentials it saved. */
export function makeProvider(conn: EposConnection, creds: EposCredentials | null, deps: ProviderDeps): EposProvider {
  if (conn.environment === 'simulator') return new TillSimulator(deps.state, conn.provider);
  if (!creds || creds.provider !== conn.provider) throw new EposError(`The ${conn.provider} credentials are missing. Someone who manages settings connects the till again in Settings.`, false);
  const environment = conn.environment;
  switch (creds.provider) {
    case 'square':
      return new SquareProvider({ accessToken: creds.accessToken, environment, fetch: deps.fetch });
    case 'toast':
      return new ToastProvider({ clientId: creds.clientId, clientSecret: creds.clientSecret, environment, fetch: deps.fetch });
    case 'lightspeed':
      if (!deps.lightspeedApp) throw new EposError('This server has no Lightspeed app set up, so it cannot reach Lightspeed.', false);
      return new LightspeedProvider({
        app: deps.lightspeedApp,
        environment,
        tokens: creds,
        fetch: deps.fetch,
        // Lightspeed retires the old refresh token, so the new pair must be kept at once.
        onTokens: (t) => saveCredentials(deps.store, deps.orgId, { provider: 'lightspeed', ...t }),
      });
  }
}
