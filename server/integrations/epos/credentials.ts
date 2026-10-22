import type { UserStore } from '../../store';
import type { EposProviderName } from './provider';

/** What each till needs to sign in. Never returned by the API; only the last four characters are shown. */
export type EposCredentials =
  | { provider: 'square'; accessToken: string }
  | { provider: 'toast'; clientId: string; clientSecret: string }
  | { provider: 'lightspeed'; accessToken: string; refreshToken: string; expiresAt: number };

/** One setting per organisation, kept with the other secrets. */
export const eposCredentialsSetting = (orgId: string) => `epos_token:${orgId}`;

export async function readCredentials(store: UserStore, orgId: string): Promise<EposCredentials | null> {
  const raw = await store.getSetting(eposCredentialsSetting(orgId));
  if (!raw) return null;
  // Organisations connected before there was a choice of till saved Square's token as it was.
  if (!raw.startsWith('{')) return { provider: 'square', accessToken: raw };
  try {
    return JSON.parse(raw) as EposCredentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(store: UserStore, orgId: string, creds: EposCredentials | null) {
  await store.setSetting(eposCredentialsSetting(orgId), creds ? JSON.stringify(creds) : null);
}

/** The end of the secret that identifies it, so two can be told apart without showing either. */
export function credentialHint(creds: EposCredentials | null): string | null {
  if (!creds) return null;
  const secret = creds.provider === 'toast' ? creds.clientId : creds.provider === 'lightspeed' ? creds.refreshToken : creds.accessToken;
  return secret.slice(-4);
}

export const providerOf = (creds: EposCredentials | null): EposProviderName | null => creds?.provider ?? null;
