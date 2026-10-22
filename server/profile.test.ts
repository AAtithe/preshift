import { describe, expect, it } from 'vitest';
import { kit } from './testkit';

// A person's own account: ending their other sessions, and an email address changed for them.

const GRACE = 'grace@marylebonegroup.example';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('sign out of other devices', () => {
  it('ends every other session and keeps this one', async () => {
    const k = await kit();
    const phone = await k.as(GRACE);
    const laptop = await k.as(GRACE);
    await tick();
    const res = await k.call('POST', '/auth/sessions/end-others', laptop);
    expect(res.status).toBe(200);
    expect(res.cookie).toBeTruthy();
    expect((await k.call('GET', '/v1/me', phone)).status).toBe(401);
    expect((await k.call('GET', '/v1/me', res.cookie!)).body.user.id).toBe('usr_sup');
    // The password still works, and the step is on the person's record.
    expect((await k.store.getUser(GRACE))?.hash).toBeTruthy();
    const org = await k.store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ action: 'access.other_sessions_ended', detail: { userId: 'usr_sup' } });
  });

  it('needs a session', async () => {
    const k = await kit();
    expect((await k.call('POST', '/auth/sessions/end-others', null)).status).toBe(401);
  });
});
