import type { RotaState } from '../engine/types';

export interface User {
  id: string;
  email: string;
  name: string;
  accountId: string;
  accountName: string;
  role: 'admin' | 'manager';
  mustChangePassword: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Something went wrong. Try again.');
  return data as T;
}

export async function getMe(): Promise<User | null> {
  try {
    return (await call<{ user: User }>('GET', 'auth/me')).user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const login = (email: string, password: string) => call<{ ok: true }>('POST', 'auth/login', { email, password });
export const changePassword = (currentPassword: string, newPassword: string) =>
  call<{ ok: true }>('POST', 'auth/password', { currentPassword, newPassword });
export const requestReset = (email: string) => call<{ ok: true; message: string }>('POST', 'auth/forgot', { email });
export const checkReset = (token: string) => call<{ ok: true; email: string }>('POST', 'auth/reset', { token });
export const resetPassword = (token: string, newPassword: string) =>
  call<{ ok: true }>('POST', 'auth/reset', { token, newPassword });
export const logout = () => call<{ ok: true }>('POST', 'auth/logout');
export const loadRota = () => call<{ state: RotaState | null; version: number }>('GET', 'state');
export const saveRota = (state: RotaState, version: number) => call<{ version: number }>('PUT', 'state', { state, version });
