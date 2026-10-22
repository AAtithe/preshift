import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkFence } from '../../src/engine/clocking';
import { requiredBreakMinutes } from '../../src/engine/compliance';
import { addDays, ageOn, weekStart } from '../../src/engine/time';
import { PULSE_RETENTION_DAYS, RECOGNITION_LABEL, welfarePolicy, type PulseResponse } from '../../src/engine/welfare';
import type { Employee, GeoFix, Site, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { emailSetting, linkFor, parseEmailSettings, sendMail, staffInviteEmail } from '../mail';
import { latestByEmployee, recordSent } from '../maillog';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { cookieFrom, createStaffSession, readStaffSession, STAFF_COOKIE, staffCookie } from '../session';
import { geoFixBody, idParam } from '../schemas';
import { audit, welfareOf, type OrgData, type StaffLogin, type Store } from '../store';
import { EMAIL, LOCK_SECONDS, MAX_FAILURES, normalise, now, secure } from './access';
import { clockIn, clockOut, endBreak, onBreak, startBreak } from './time';

const INVITE_DAYS = 7;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Staff {
  login: StaffLogin;
  org: OrgData;
  employee: Employee;
}

/** The member of staff behind a request, checked against the database every time, or null. */
async function staffOf(req: FastifyRequest, store: Store): Promise<Staff | null> {
  const claims = await readStaffSession(cookieFrom(req.headers.cookie, STAFF_COOKIE), await store.sessionSecret());
  if (!claims) return null;
  const login = await store.getStaffLogin(claims.orgId, claims.employeeId);
  if (!login?.hash || claims.issuedAt < login.sessionsValidFrom) return null;
  const org = await store.load(claims.orgId);
  const employee = org.state.employees.find((e) => e.id === claims.employeeId);
  // A leaver's login stops working the moment they are marked as left.
  if (!employee || employee.status === 'leaver') return null;
  return { login, org, employee };
}

async function requireStaff(req: FastifyRequest, store: Store): Promise<Staff> {
  const staff = await staffOf(req, store);
  if (!staff) throw new HttpError(401, 'unauthorised', 'Sign in to continue.');
  return staff;
}

async function signedIn(req: FastifyRequest, reply: FastifyReply, store: Store, login: StaffLogin, issuedAt = Date.now()) {
  const token = await createStaffSession(login, await store.sessionSecret(), issuedAt);
  // Not returned: a Fastify reply is thenable, and awaiting it waits for the response to be sent.
  reply.header('set-cookie', staffCookie(token, secure(req)));
}

/** The sites a person may clock at: today's shifts first, nearest start first, then their home and cover sites. */
function clockableSites(org: OrgData, employee: Employee, at: Date): Site[] {
  const { date, minute } = londonParts(at);
  const shiftSites = org.state.shifts
    .filter((s) => s.employeeId === employee.id && s.date === date)
    .sort((a, b) => Math.abs(a.startMinute - minute) - Math.abs(b.startMinute - minute))
    .map((s) => s.siteId);
  const ids = [...shiftSites, employee.siteId, ...(employee.coverSiteIds ?? [])].filter((id, i, all) => all.indexOf(id) === i);
  return ids.map((id) => org.state.sites.find((s) => s.id === id)).filter((s): s is Site => Boolean(s));
}

const siteView = (s: Site) => ({ id: s.id, name: s.name, geofence: s.geofence ?? null });

/**
 * Marks that a person has answered a week's pulse, so nobody answers twice. A keyed hash of person and
 * week, with the key kept apart from the organisation's data: the marker cannot be matched to an answer,
 * which carries no id, and nobody reading the data can tell whose marker it is without the key.
 */
async function pulseMarker(store: Store, orgId: string, employeeId: string, week: string) {
  const key = await store.settingOnce(`pulse_key:${orgId}`, () => randomBytes(32).toString('hex'));
  return `${week}:${createHmac('sha256', key).update(`${employeeId}|${week}`).digest('hex')}`;
}

/** What the staff app shows about looking after them: support, the weekly pulse, rewards and thanks received. */
async function welfareView({ org, employee }: Staff, store: Store, today: string) {
  const w = org.welfare;
  const week = weekStart(today);
  const marker = await pulseMarker(store, org.orgId, employee.id, week);
  return {
    supportLine: welfarePolicy(w?.policy).supportLine ?? null,
    pulse: { week, answered: (w?.pulseAnswered ?? []).includes(marker) },
    chatOpen: (w?.chats ?? []).some((c) => c.employeeId === employee.id && c.status === 'open'),
    rewards: {
      connected: !!w?.rewards,
      member: (w?.rewardsEnrolled ?? []).includes(employee.id),
      optedOut: (w?.rewardsOptOut ?? []).includes(employee.id),
    },
    recognitions: (w?.recognitions ?? [])
      .filter((r) => r.employeeId === employee.id && r.at >= addDays(today, -90))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((r) => ({ id: r.id, at: r.at, label: RECOGNITION_LABEL[r.category], message: r.message, points: r.points, by: r.by })),
  };
}

/** Everything the staff app shows: only this person's own shifts and hours. */
async function overview(staff: Staff, store: Store) {
  const { org, employee, login } = staff;
  const today = londonParts(new Date()).date;
  const siteName = (id: string) => org.state.sites.find((s) => s.id === id)?.name ?? id;
  const roleName = (id: string) => org.state.roles.find((r) => r.id === id)?.name ?? id;
  const entryView = (t: TimeEntry) => ({
    id: t.id, date: t.date, siteId: t.siteId, siteName: siteName(t.siteId), clockIn: t.clockIn, clockOut: t.clockOut ?? null,
    breakMinutes: t.breakMinutes, status: t.status, method: t.method ?? null,
    breaks: t.breaks ?? [], onBreak: onBreak(t),
  });
  const open = org.timeEntries.find((t) => t.employeeId === employee.id && t.status === 'open');
  // The legal minimum for the shift they are on, so people know what they are owed.
  const shift = open
    ? org.state.shifts.find((s) => s.id === open.shiftId)
    : org.state.shifts.find((s) => s.employeeId === employee.id && s.date === today && s.published);
  const owed = shift ? requiredBreakMinutes(shift.endMinute - shift.startMinute, ageOn(employee.dateOfBirth, today)) : 0;
  return {
    employee: { id: employee.id, name: employee.name },
    email: login.email,
    today,
    sites: clockableSites(org, employee, new Date()).map(siteView),
    open: open ? entryView(open) : null,
    breakEntitlement: owed ? { minutes: owed, planned: shift!.breakMinutes, under18: ageOn(employee.dateOfBirth, today) < 18 } : null,
    // Only published shifts: until the rota is published it is still the manager's draft.
    shifts: org.state.shifts
      .filter((s) => s.employeeId === employee.id && s.published && s.date >= today && s.date <= addDays(today, 13))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
      .map((s) => ({ id: s.id, date: s.date, startMinute: s.startMinute, endMinute: s.endMinute, breakMinutes: s.breakMinutes, siteName: siteName(s.siteId), roleName: roleName(s.roleId) })),
    recent: org.timeEntries
      .filter((t) => t.employeeId === employee.id && t.date >= addDays(today, -13) && t.status !== 'open')
      .sort((a, b) => b.date.localeCompare(a.date) || b.clockIn - a.clockIn)
      .slice(0, 20)
      .map(entryView),
    welfare: await welfareView(staff, store, today),
  };
}

/**
 * The staff app's own API, outside the manager API. Signing in here gives a staff session,
 * which this API alone accepts, and which reaches only the person's own shifts and clocking.
 */
export function staffRoutes(app: FastifyInstance, store: Store) {
  const hidden = { schema: { hide: true } };

  async function invited(orgId: string, employeeId: string, token: string) {
    const login = orgId && employeeId ? await store.getStaffLogin(orgId, employeeId) : null;
    const valid = login?.inviteHash && (login.inviteExpires ?? 0) > now() && sameHash(login.inviteHash, sha256(token));
    if (!login || !valid) throw new HttpError(410, 'invite_invalid', 'This invite link has expired or been replaced. Ask your manager for a new one.');
    const org = await store.load(orgId);
    const employee = org.state.employees.find((e) => e.id === employeeId);
    if (!employee || employee.status === 'leaver') throw new HttpError(410, 'invite_invalid', 'This invite is no longer valid.');
    return { login, org, employee };
  }

  // Who an invite is for, so the phone can greet them. The token comes in the body, never the
  // address, so it stays out of server and proxy logs.
  app.post<{ Body: { org?: string; person?: string; invite?: string } }>('/v1/staff/invite', hidden, async (req) => {
    const { login, employee } = await invited(req.body?.org ?? '', req.body?.person ?? '', req.body?.invite ?? '');
    return { name: employee.name, email: login.email ?? employee.email ?? '' };
  });

  app.post<{ Body: { org?: string; person?: string; invite?: string; email?: string; password?: string } }>('/v1/staff/join', hidden, async (req, reply) => {
    const { login, org, employee } = await invited(req.body?.org ?? '', req.body?.person ?? '', req.body?.invite ?? '');
    const email = normalise(req.body?.email);
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
    const problem = passwordProblem(req.body?.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    const issued = Date.now();
    const next: StaffLogin = {
      ...login,
      email,
      ...(await hashPassword(req.body.password!)),
      inviteHash: undefined,
      inviteExpires: undefined,
      activatedAt: new Date(issued).toISOString(),
      lastSignInAt: new Date(issued).toISOString(),
      // Accepting a fresh invite is also how a forgotten password is reset: older sessions end.
      sessionsValidFrom: issued,
      failedAttempts: 0,
      lockedUntil: 0,
    };
    if (!(await store.putStaffLogin(next))) throw new HttpError(409, 'email_taken', 'That email is already used by another staff login.');
    audit(org, `staff:${employee.id}`, 'staff.login_activated', { employeeId: employee.id });
    await store.save(org);
    await signedIn(req, reply, store, next, issued);
    return overview({ login: next, org, employee }, store);
  });

  app.post<{ Body: { email?: string; password?: string } }>('/v1/staff/login', hidden, async (req, reply) => {
    const email = normalise(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const login = email ? await store.getStaffLoginByEmail(email) : null;
    if (login && login.lockedUntil > now()) {
      throw new HttpError(429, 'locked', 'Too many wrong passwords. Wait 15 minutes, or ask your manager for a new invite.');
    }
    const ok = await verifyPassword(login?.hash && login.salt ? { salt: login.salt, hash: login.hash } : null, password);
    if (!ok || !login) {
      if (login) {
        const failedAttempts = login.failedAttempts + 1;
        const lock = failedAttempts >= MAX_FAILURES;
        await store.putStaffLogin({ ...login, failedAttempts: lock ? 0 : failedAttempts, lockedUntil: lock ? now() + LOCK_SECONDS : 0 });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw new HttpError(401, 'invalid', 'That email and password do not match.');
    }
    const org = await store.load(login.orgId);
    const employee = org.state.employees.find((e) => e.id === login.employeeId);
    if (!employee || employee.status === 'leaver') throw new HttpError(403, 'closed', 'This staff login has been closed.');
    const next = { ...login, failedAttempts: 0, lockedUntil: 0, lastSignInAt: new Date().toISOString() };
    await store.putStaffLogin(next);
    await signedIn(req, reply, store, next);
    return overview({ login: next, org, employee }, store);
  });

  app.post('/v1/staff/logout', hidden, async (req, reply) => reply.header('set-cookie', staffCookie('', secure(req), 0)).send({ ok: true }));

  app.get('/v1/staff/me', hidden, async (req) => overview(await requireStaff(req, store), store));

  app.post<{ Body: { siteId?: string; location?: GeoFix } }>(
    '/v1/staff/clock-in',
    { schema: { hide: true, body: { type: 'object', properties: { siteId: { type: 'string' }, location: geoFixBody } } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const sites = clockableSites(org, employee, new Date());
      const fenced = sites.filter((s) => s.geofence && (!req.body?.siteId || s.id === req.body.siteId));
      // On a person's own phone the location is the only proof they are at work, so a site without one is closed to it.
      if (fenced.length === 0) {
        throw new HttpError(409, 'site_not_set_up', 'Your site has not set its location for phone clocking yet. Clock in at the site tablet or card reader.');
      }
      const fix = req.body?.location;
      const site = (fix && fenced.find((s) => checkFence(s.geofence!, fix).ok)) || fenced[0];
      const entry = clockIn(org, employee, site.id, { method: 'phone', location: fix });
      audit(org, `staff:${employee.id}`, 'time.phone_clock_in', { id: entry.id, siteId: site.id });
      await store.save(org);
      return overview(staff, store);
    },
  );

  app.post<{ Body: { location?: GeoFix } }>(
    '/v1/staff/clock-out',
    { schema: { hide: true, body: { type: 'object', properties: { location: geoFixBody } } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const entry = org.timeEntries.find((t) => t.employeeId === employee.id && t.status === 'open');
      if (!entry) throw new HttpError(409, 'not_clocked_in', 'You are not clocked in.');
      if (!org.state.sites.find((s) => s.id === entry.siteId)?.geofence) {
        throw new HttpError(409, 'site_not_set_up', 'Phone clocking is off at this site now. Clock out at the site tablet or card reader, or ask your manager.');
      }
      clockOut(org, entry, { method: 'phone', location: req.body?.location });
      audit(org, `staff:${employee.id}`, 'time.phone_clock_out', { id: entry.id });
      await store.save(org);
      return overview(staff, store);
    },
  );

  breakRoutes(app, store);
  welfareStaffRoutes(app, store);
}

/**
 * Looking after themselves, from their own phone: a weekly "How was your week?", asking for a private
 * chat, and whether they want Hospitality Rewards. Each acts on the caller alone.
 */
function welfareStaffRoutes(app: FastifyInstance, store: Store) {
  const openChat = (staff: Staff) => {
    const w = welfareOf(staff.org);
    if (w.chats.some((c) => c.employeeId === staff.employee.id && c.status === 'open')) return;
    w.chats.push({ id: `chat_${randomUUID()}`, employeeId: staff.employee.id, siteId: staff.employee.siteId, at: new Date().toISOString(), status: 'open' });
    audit(staff.org, `staff:${staff.employee.id}`, 'staff.chat_requested', { employeeId: staff.employee.id });
  };

  app.post<{ Body: { score?: number; chat?: boolean } }>(
    '/v1/staff/pulse',
    { schema: { hide: true, body: { type: 'object', required: ['score'], additionalProperties: false, properties: { score: { type: 'integer', minimum: 1, maximum: 5 }, chat: { type: 'boolean' } } } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const today = londonParts(new Date()).date;
      const week = weekStart(today);
      const marker = await pulseMarker(store, org.orgId, employee.id, week);
      const w = welfareOf(org);
      if (w.pulseAnswered.includes(marker)) throw new HttpError(409, 'answered', 'You have already answered this week. Thank you.');
      // Kept without who gave it, and placed anywhere in the list, so the order of answers says nothing either.
      const answer: PulseResponse = { siteId: employee.siteId, week, score: req.body.score as PulseResponse['score'] };
      w.pulses.splice(randomInt(w.pulses.length + 1), 0, answer);
      w.pulseAnswered.push(marker);
      const oldest = weekStart(addDays(today, -PULSE_RETENTION_DAYS));
      w.pulses = w.pulses.filter((p) => p.week >= oldest);
      w.pulseAnswered = w.pulseAnswered.filter((m) => m.slice(0, 10) >= oldest);
      if (req.body.chat) openChat(staff);
      await store.save(org);
      return overview(staff, store);
    },
  );

  app.post('/v1/staff/chat', { schema: { hide: true } }, async (req) => {
    const staff = await requireStaff(req, store);
    openChat(staff);
    await store.save(staff.org);
    return overview(staff, store);
  });

  app.post<{ Body: { optOut?: boolean } }>(
    '/v1/staff/rewards',
    { schema: { hide: true, body: { type: 'object', required: ['optOut'], additionalProperties: false, properties: { optOut: { type: 'boolean' } } } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const w = welfareOf(org);
      const out = w.rewardsOptOut.filter((id) => id !== employee.id);
      w.rewardsOptOut = req.body.optOut ? [...out, employee.id] : out;
      // Removed from the platform at the next sync, the next morning at the latest.
      audit(org, `staff:${employee.id}`, req.body.optOut ? 'staff.rewards_opted_out' : 'staff.rewards_opted_in', { employeeId: employee.id });
      await store.save(org);
      return overview(staff, store);
    },
  );
}

/**
 * Breaks need no location check: a break is unpaid time, so recording one can only lower the
 * hours paid, and people often take it away from the building.
 */
function breakRoutes(app: FastifyInstance, store: Store) {
  for (const [path, action, apply] of [
    ['/v1/staff/break-start', 'time.phone_break_start', startBreak],
    ['/v1/staff/break-end', 'time.phone_break_end', endBreak],
  ] as const) {
    app.post(path, { schema: { hide: true } }, async (req) => {
      const staff = await requireStaff(req, store);
      const entry = staff.org.timeEntries.find((t) => t.employeeId === staff.employee.id && t.status === 'open');
      if (!entry) throw new HttpError(409, 'not_clocked_in', 'You are not clocked in.');
      apply(entry);
      audit(staff.org, `staff:${staff.employee.id}`, action, { id: entry.id });
      await store.save(staff.org);
      return overview(staff, store);
    });
  }
}

/**
 * Managers invite staff and close logins. Registered inside the authenticated API. A staff login
 * is part of running the team, so it answers to team.manage at the person's home site, as
 * changing their record does: a GM sees and issues logins for their own sites' people only.
 */
export function staffAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const write = { preHandler: requireScope('rota:write') };
  const actor = (req: FastifyRequest) => actorName(guard(ctx, req, orgOf(req)));

  const employeeOf = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const employee = orgOf(req).state.employees.find((e) => e.id === req.params.id);
    if (!employee) throw notFound(`Employee ${req.params.id}`);
    guard(ctx, req, orgOf(req)).allow('team.manage', employee.siteId);
    return employee;
  };

  app.get('/v1/staff-logins', { ...write, schema: { tags: ['Staff app'], description: 'Who has a staff app login, and who has an invite waiting, at the sites the caller manages the team.' } }, async (req) => {
    const org = orgOf(req);
    const manages = guard(ctx, req, org).at('team.manage');
    const home = new Map(org.state.employees.map((e) => [e.id, e.siteId]));
    const mail = latestByEmployee(org);
    return (await store.listStaffLogins(req.principal.orgId))
      .filter((l) => home.has(l.employeeId) && manages({ siteId: home.get(l.employeeId)! }))
      .map((l) => ({
      employeeId: l.employeeId,
      email: l.email ?? null,
      status: l.hash ? 'active' : (l.inviteExpires ?? 0) > now() ? 'invited' : 'expired',
      inviteExpires: l.inviteExpires ? new Date(l.inviteExpires * 1000).toISOString() : null,
      inviteWaiting: Boolean(l.inviteHash && (l.inviteExpires ?? 0) > now()),
      lastEmail: mail.get(l.employeeId) ?? null,
      activatedAt: l.activatedAt ?? null,
      lastSignInAt: l.lastSignInAt ?? null,
      locked: l.lockedUntil > now(),
    }));
  });

  app.post<{ Params: { id: string }; Body: { handOver?: boolean } | undefined }>(
    '/v1/staff-logins/:id/invite',
    {
      ...write,
      schema: {
        tags: ['Staff app'],
        description:
          'Creates a one-time invite link, valid for 7 days, for the person to set up their staff login on their phone. ' +
          'Sending a new one replaces any earlier link, and is also how a forgotten password is reset. ' +
          "Once email is set up under Settings it is emailed to the person's own address (their login's, else the one on their record) " +
          'and not returned; `handOver: true`, no address or a refused send returns the link to pass on instead. ' +
          'Once the person has set up their login, a new link only ever goes to the address they signed up with: it is never ' +
          'returned, and without email set up it is refused (`email_only`), so nobody but the person can sign in as them and clock their hours.',
        params: idParam,
        body: { type: ['object', 'null'], properties: { handOver: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    async (req, reply) => {
      const employee = employeeOf(req);
      if (employee.status === 'leaver') throw new HttpError(409, 'leaver', `${employee.name} has left.`);
      const token = randomBytes(24).toString('base64url');
      const existing = await store.getStaffLogin(req.principal.orgId, employee.id);
      const org = orgOf(req);
      const settings = parseEmailSettings(await store.getSetting(emailSetting(org.orgId)));
      const handOver = req.body?.handOver === true;
      // A login someone has set up opens their clocking, and clocked hours are pay: whoever held a
      // link to it could sign in as them. So it only ever goes to their own inbox, checked before
      // any link is made.
      const joined = Boolean(existing?.hash);
      if (joined && (handOver || !settings)) {
        throw new HttpError(
          409,
          'email_only',
          `${employee.name} has set up their login, so a new link only ever goes to their own email, never to anyone else. ` +
            (handOver
              ? `It cannot be handed over. If they no longer use ${existing!.email}, close their login and invite them again.`
              : 'Set up email under Settings first, or close their login and invite them again.'),
        );
      }
      const login: StaffLogin = existing ?? {
        orgId: req.principal.orgId,
        employeeId: employee.id,
        invitedBy: actor(req),
        createdAt: new Date().toISOString(),
        sessionsValidFrom: 0,
        failedAttempts: 0,
        lockedUntil: 0,
      };
      const expires = now() + INVITE_DAYS * 86_400;
      await store.putStaffLogin({ ...login, inviteHash: sha256(token), inviteExpires: expires, invitedBy: actor(req) });
      // After #, which browsers never send to a server or in a Referer header.
      const fragment = new URLSearchParams({ org: req.principal.orgId, person: employee.id, invite: token });
      const path = `/staff/#${fragment}`;
      const expiresAt = new Date(expires * 1000).toISOString();

      // To the person's own inbox where there is one: the login's address once they have joined, else their record's.
      const to = (existing?.email ?? employee.email ?? '').trim().toLowerCase();
      const why = handOver ? 'handed_over' : !settings ? 'email_not_set_up' : !EMAIL.test(to) ? 'no_address' : null;
      if (why === null) {
        const site = org.state.sites.find((x) => x.id === employee.siteId)?.name ?? 'your site';
        const message = staffInviteEmail(to, employee.name, actor(req), site, linkFor(settings, path), INVITE_DAYS, !!existing?.hash);
        const id = await sendMail(settings!, message);
        if (id !== null) {
          if (id) recordSent(org, id, { to, kind: 'staff_invite', employeeId: employee.id, by: actor(req) });
          audit(org, actor(req), 'staff.invited', { employeeId: employee.id, emailed: true });
          // The link stays between the person and their inbox.
          return reply.code(201).send({ emailed: true, to, expiresAt });
        }
        audit(org, actor(req), 'staff.invited', { employeeId: employee.id, emailed: false });
        // Never handed back for a login they have set up, even when the email fails.
        if (joined) return reply.code(201).send({ emailed: false, reason: 'send_failed', expiresAt, emailProblem: 'The email did not go. Check the email settings and send again; this link only ever goes to their own email.' });
        return reply.code(201).send({ emailed: false, reason: 'send_failed', path, expiresAt, emailProblem: 'The email did not go. Check the email settings, or hand this link over yourself.' });
      }
      audit(org, actor(req), 'staff.invited', { employeeId: employee.id, emailed: false });
      return reply.code(201).send({ emailed: false, reason: why, path, expiresAt });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/staff-logins/:id',
    { ...write, schema: { tags: ['Staff app'], description: 'Closes a staff login and signs them out on every phone.', params: idParam } },
    async (req, reply) => {
      const employee = employeeOf(req);
      await store.deleteStaffLogin(req.principal.orgId, employee.id);
      audit(orgOf(req), actor(req), 'staff.login_closed', { employeeId: employee.id });
      return reply.code(204).send();
    },
  );
}
