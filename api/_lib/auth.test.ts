import { DUMMY_HASH, hashPassword, newPasswordProblem, verifyPassword } from './password.js';
import { readCookie } from './session.js';
import { appUrl } from './urls.js';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('never matches the dummy hash or a malformed one', async () => {
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    const req = new Request('https://x.test/', { headers: { cookie: 'a=1; ps_session=abc%3D; b=2' } });
    expect(readCookie(req, 'ps_session')).toBe('abc=');
    expect(readCookie(req, 'missing')).toBeNull();
  });
});

describe('newPasswordProblem', () => {
  const email = 't.stanley@williamsstanley.co';
  it('accepts a long, unrelated passphrase', () => {
    expect(newPasswordProblem('harbour copper linen 47', email)).toBeNull();
  });
  it('rejects short, repetitive or guessable passwords', () => {
    expect(newPasswordProblem('short1', email)).toMatch(/12 characters/);
    expect(newPasswordProblem('aaaaaaaaaaaaaaaa', email)).toMatch(/mix/);
    expect(newPasswordProblem('t.stanley-2026!!', email)).toMatch(/email/);
    expect(newPasswordProblem('MyPreshiftLogin1', email)).toMatch(/firm/);
  });
});

describe('appUrl', () => {
  const original = process.env.APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  });

  it('uses APP_URL whatever host the request claims', () => {
    process.env.APP_URL = 'https://rota.example.co.uk/';
    expect(appUrl(new Request('https://evil.test/api/auth/forgot'), '/app/reset')).toBe('https://rota.example.co.uk/app/reset');
  });

  it('falls back to the request only on localhost', () => {
    delete process.env.APP_URL;
    expect(appUrl(new Request('http://localhost:5173/api/auth/forgot'), '/app/reset')).toBe('http://localhost:5173/app/reset');
    expect(appUrl(new Request('https://evil.test/api/auth/forgot'), '/app/reset')).toBeNull();
  });
});
