import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkFence } from '../../src/engine/clocking';
import { requiredBreakMinutes } from '../../src/engine/compliance';
import { addDays, ageOn, weekStart } from '../../src/engine/time';
import { fortnight } from '../../src/engine/rotaViews';
import { confirmWeek, pruneSeen, weeksSeen } from '../../src/engine/rotaSeen';
import { dayLabel } from '../../src/engine/requests';
import { PULSE_RETENTION_DAYS, RECOGNITION_LABEL, welfarePolicy, type PulseResponse } from '../../src/engine/welfare';
import type { Employee, GeoFix, RightToWorkDocument, Site, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { MAX_PUSH_DEVICES, pushSubject, sendPush, validEndpoint, vapidKeys, type PushDevice } from '../push';
import { emailSetting, linkFor, parseEmailSettings, sendMail, staffInviteEmail } from '../mail';
import { latestByEmployee, recordSent } from '../maillog';
import { setPin } from '../kioskPin';
import { hashPassword, passwordProblem, verifyPassword } from '../passwords';
import { cookieFrom, createStaffSession, readStaffSession, STAFF_COOKIE, staffCookie } from '../session';
import { geoFixBody, idParam, isoDate } from '../schemas';
import { canOrgWide } from '../../src/engine/access';
import { loginCases, reviewRefusal, type StaffLoginEvent } from '../../src/engine/loginreview';
import { audit, welfareOf, type OrgData, type StaffLogin, type Store } from '../store';
import { balanceOf, ownRequestView, requestsOf, staffRequestRoutes } from './requests';
import { cipherOf, cleanFileName, MAX_DOCUMENT_BYTES, sniffType } from './documents';
import { EMAIL, LOCK_SECONDS, MAX_FAILURES, normalise, now, secure } from './access';
import { clockIn, clockOut, endBreak, onBreak, startBreak } from './time';

const INVITE_DAYS = 7;

/** Writes to the staff login log beside the audit entry: the close review reads this, as the audit log is trimmed. */
function logLogin(org: OrgData, event: Omit<StaffLoginEvent, 'at'>) {
  org.staffLoginLog.push({ at: new Date().toISOString(), ...event });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface Staff {
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

export async function requireStaff(req: FastifyRequest, store: Store): Promise<Staff> {
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
    /** How many phones have notifications on. */
    pushDevices: login.push?.length ?? 0,
    /** Shift reminders: on unless the person turned them off. */
    reminders: login.reminders !== false,
    today,
    sites: clockableSites(org, employee, new Date()).map(siteView),
    open: open ? entryView(open) : null,
    breakEntitlement: owed ? { minutes: owed, planned: shift!.breakMinutes, under18: ageOn(employee.dateOfBirth, today) < 18 } : null,
    // Whether they have a kiosk PIN, and whether any site they clock at asks for one.
    kioskPin: { set: Boolean(employee.kioskPinSetAt), required: clockableSites(org, employee, new Date()).some((s) => s.kioskPinRequired) },
    // Only published shifts: until the rota is published it is still the manager's draft.
    shifts: org.state.shifts
      .filter((s) => s.employeeId === employee.id && s.published && s.date >= today && s.date <= addDays(today, 13))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
      .map((s) => ({ id: s.id, date: s.date, startMinute: s.startMinute, endMinute: s.endMinute, breakMinutes: s.breakMinutes, siteName: siteName(s.siteId), roleName: roleName(s.roleId) })),
    // Hours, pay before tax and rest over the same fortnight, from the published shifts above.
    fortnight: fortnightOf(org, employee, today),
    recent: org.timeEntries
      .filter((t) => t.employeeId === employee.id && t.date >= addDays(today, -13) && t.status !== 'open')
      .sort((a, b) => b.date.localeCompare(a.date) || b.clockIn - a.clockIn)
      .slice(0, 20)
      .map(entryView),
    welfare: await welfareView(staff, store, today),
    ...selfService(org, employee, today),
  };
}

function fortnightOf(org: OrgData, employee: Employee, today: string) {
  const published = org.state.shifts.filter((s) => s.employeeId === employee.id && s.published);
  const mine = published.filter((s) => s.date >= today && s.date <= addDays(today, 13));
  // The last shift before the fortnight, so the rest into its first shift is right.
  const before = published
    .filter((s) => s.date < today && s.date >= addDays(today, -2))
    .sort((a, b) => b.date.localeCompare(a.date) || b.endMinute - a.endMinute)[0];
  return fortnight(employee, mine, today, before);
}

/** What the person can ask for and has asked for: their holiday, availability, requests and messages. */
function selfService(org: OrgData, employee: Employee, today: string) {
  const balance = balanceOf(org, employee, today);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const sick = (employee.absences ?? []).find((a) => a.type === 'sickness' && !a.to);
  const recentSick = (employee.absences ?? []).filter((a) => a.type === 'sickness' && (!a.to || a.to >= addDays(today, -60))).at(-1);
  // Weeks from this one on that they have not confirmed as they now stand, one entry per week across sites.
  const thisWeek = weekStart(today);
  const toConfirm = weeksSeen(org.toldWeeks ?? {}, org.rotaSeen ?? {}, (w) => w.employeeId === employee.id && w.weekStart >= thisWeek).filter((w) => !w.seen);
  const weeks = [...new Set(toConfirm.map((w) => w.weekStart))].sort();
  return {
    rotaToConfirm: weeks.map((ws) => ({ weekStart: ws, label: `Week of ${dayLabel(ws)}`, changed: toConfirm.some((w) => w.weekStart === ws && w.changed) })),
    unread: (org.notifications ?? []).filter((n) => n.employeeId === employee.id && !n.read).length,
    holiday: {
      remainingHours: r1(balance.remainingHours),
      bookedHours: r1(balance.bookedHours),
      takenHours: r1(balance.takenHours),
      dayHours: r1(balance.dayHours),
      yearEnd: balance.year.end,
      upcoming: employee.leave.filter((d) => d >= today).sort(),
    },
    availability: employee.availability,
    unavailable: (employee.unavailable ?? []).filter((u) => u.date >= today),
    sick: sick ? { from: sick.from } : null,
    fitNoteFor: recentSick ? { from: recentSick.from, to: recentSick.to ?? null, uploaded: recentSick.fitNotes?.length ?? 0 } : null,
    requests: requestsOf(org)
      .filter((r) => r.employeeId === employee.id && (r.status === 'pending' || r.status === 'accepted' || (r.decidedAt ?? r.createdAt) >= `${addDays(today, -30)}`))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((r) => ownRequestView(org, r)),
  };
}

/**
 * The staff app's own API, outside the manager API. Signing in here gives a staff session,
 * which this API alone accepts, and which reaches only the person's own shifts and clocking.
 */
export function staffRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
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
    logLogin(org, { employeeId: employee.id, kind: 'activated', by: `staff:${employee.id}`, email });
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

  // The person sets their own kiosk PIN, signed in as themselves, so nobody can set one for a colleague.
  app.put<{ Body: { pin: string } }>(
    '/v1/staff/kiosk-pin',
    { schema: { hide: true, body: { type: 'object', required: ['pin'], additionalProperties: false, properties: { pin: { type: 'string', maxLength: 12 } } } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      await setPin(store, staff.org.orgId, staff.employee, req.body.pin, 'self');
      audit(staff.org, `staff:${staff.employee.id}`, 'kiosk.pin_set', { employeeId: staff.employee.id });
      await store.save(staff.org);
      return overview(staff, store);
    },
  );

  welfareStaffRoutes(app, store);
  staffRequestRoutes(app, ctx, (req) => requireStaff(req, store));
  pushRoutes(app, store);

  // A fit note, photographed on the phone. Stored encrypted with the right to work copies, read only by
  // those who read the personnel file, and attached to the person's current or latest sickness.
  app.post<{ Querystring: { fileName?: string }; Body: Buffer }>(
    '/v1/staff/fit-note',
    {
      bodyLimit: MAX_DOCUMENT_BYTES,
      schema: { hide: true, querystring: { type: 'object', properties: { fileName: { type: 'string', maxLength: 255 } } } },
      onResponse: async (req, reply) => {
        const id = uploaded.get(req);
        if (id && reply.statusCode >= 400) await store.deleteDocument(id.orgId, id.documentId);
      },
    },
    async (req, reply) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const today = londonParts(new Date()).date;
      const absence = (employee.absences ?? []).filter((a) => a.type === 'sickness' && (!a.to || a.to >= addDays(today, -60))).at(-1);
      if (!absence) throw new HttpError(409, 'no_sickness', 'A fit note goes with a sickness absence. Report sickness first, or give it to your manager.');
      if ((absence.fitNotes?.length ?? 0) >= 5) throw new HttpError(409, 'too_many_documents', 'Five fit notes are already on file for this absence. Give any more to your manager.');
      const cipher = cipherOf(ctx);
      const data = Buffer.isBuffer(req.body) ? req.body : null;
      if (!data?.length) throw new HttpError(400, 'invalid_request', 'Send the photo or PDF of the fit note.');
      const contentType = sniffType(data);
      if (!contentType) throw new HttpError(415, 'unsupported_file', 'Send a photo (JPEG, PNG or WebP) or a PDF.');
      const doc: RightToWorkDocument = {
        id: `fit_${randomUUID()}`,
        fileName: cleanFileName(req.query.fileName, contentType, 'fit-note'),
        contentType,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        uploadedAt: new Date().toISOString(),
        uploadedBy: employee.name,
      };
      await store.putDocument(org.orgId, doc.id, { contentType, data: cipher.seal(org.orgId, doc.id, data) });
      uploaded.set(req, { orgId: org.orgId, documentId: doc.id });
      absence.fitNotes = [...(absence.fitNotes ?? []), doc];
      audit(org, `staff:${employee.id}`, 'hr.absence.updated', { id: employee.id, absenceId: absence.id, fields: ['fitNotes'] });
      await store.save(org);
      await store.logDocumentAccess({ orgId: org.orgId, documentId: doc.id, employeeId: employee.id, action: 'added', at: doc.uploadedAt, actor: `staff:${employee.id}`, via: 'staff app', ip: req.ip });
      return reply.code(201).send(await overview(staff, store));
    },
  );
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

const uploaded = new WeakMap<FastifyRequest, { orgId: string; documentId: string }>();

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
      pushDevices: l.push?.length ?? 0,
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
          logLogin(org, { employeeId: employee.id, kind: 'invited', by: actor(req), emailed: true });
          // The link stays between the person and their inbox.
          return reply.code(201).send({ emailed: true, to, expiresAt });
        }
        audit(org, actor(req), 'staff.invited', { employeeId: employee.id, emailed: false });
        logLogin(org, { employeeId: employee.id, kind: 'invited', by: actor(req), emailed: false });
        // Never handed back for a login they have set up, even when the email fails.
        if (joined) return reply.code(201).send({ emailed: false, reason: 'send_failed', expiresAt, emailProblem: 'The email did not go. Check the email settings and send again; this link only ever goes to their own email.' });
        return reply.code(201).send({ emailed: false, reason: 'send_failed', path, expiresAt, emailProblem: 'The email did not go. Check the email settings, or hand this link over yourself.' });
      }
      audit(org, actor(req), 'staff.invited', { employeeId: employee.id, emailed: false });
      logLogin(org, { employeeId: employee.id, kind: 'invited', by: actor(req), emailed: false });
      return reply.code(201).send({ emailed: false, reason: why, path, expiresAt });
    },
  );

  // ----- The review of logins closed and opened again -----

  /** A person who reads the access trail across the organisation: reviews are signed by name, so never a key. */
  const loginReviewer = (req: FastifyRequest) => {
    const g = guard(ctx, req, orgOf(req));
    const today = store.todayISO();
    if (g.actor.kind !== 'user') throw new HttpError(403, 'forbidden', 'Staff login reviews are made by people signed in, never by an integration key.');
    if (!canOrgWide(g.actor.user, 'audit.view', today) && !canOrgWide(g.actor.user, 'users.manage', today)) {
      throw new HttpError(403, 'forbidden', 'Reviewing staff logins needs audit or access management rights across the organisation.');
    }
    return actorName(g);
  };
  const casesOf = (org: OrgData, from: string, to: string) => {
    const people = new Map(org.state.employees.map((e) => [e.id, e]));
    return loginCases(org.staffLoginLog, org.loginReviews, org.timeEntries, from, to).map((c) => ({
      ...c,
      name: people.get(c.employeeId)?.name ?? c.employeeId,
      siteId: people.get(c.employeeId)?.siteId ?? null,
    }));
  };

  app.get<{ Querystring: { from: string; to: string } }>(
    '/v1/staff-logins/review',
    {
      schema: {
        tags: ['Staff app'],
        description:
          'Every staff login closed between `from` and `to`, followed through any re-invite and re-join, flagged where the same person closed and re-invited it, ' +
          'the new link was handed over, it was set up with a different email, or hours have been clocked by phone since. Opened-again logins need a sign-off.',
        querystring: { type: 'object', required: ['from', 'to'], properties: { from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      loginReviewer(req);
      const cases = casesOf(orgOf(req), req.query.from, req.query.to);
      return {
        cases,
        summary: { closed: cases.length, needsReview: cases.filter((c) => c.needsReview).length, highRisk: cases.filter((c) => c.risk === 'high' && c.needsReview).length },
      };
    },
  );

  app.post<{ Body: { caseId: string; outcome: 'genuine' | 'concern'; note: string } }>(
    '/v1/staff-logins/review',
    {
      schema: {
        tags: ['Staff app'],
        description: 'Signs off one login closed and opened again: genuine, or a concern to follow up. Never by whoever closed or re-invited it.',
        body: {
          type: 'object',
          required: ['caseId', 'outcome', 'note'],
          additionalProperties: false,
          properties: { caseId: { type: 'string' }, outcome: { enum: ['genuine', 'concern'] }, note: { type: 'string', minLength: 10, maxLength: 2000 } },
        },
      },
    },
    async (req, reply) => {
      const by = loginReviewer(req);
      const org = orgOf(req);
      const found = casesOf(org, '0000-01-01', '9999-12-31').find((c) => c.id === req.body.caseId);
      if (!found) throw notFound(`Login close ${req.body.caseId}`);
      const refused = reviewRefusal(found, by);
      if (refused) throw new HttpError(409, 'review_refused', refused);
      const review = { caseId: found.id, at: new Date().toISOString(), by, outcome: req.body.outcome, note: req.body.note.trim() };
      org.loginReviews.push(review);
      audit(org, by, 'staff.login_reviewed', { employeeId: found.employeeId, caseId: found.id, outcome: review.outcome, risk: found.risk });
      return reply.code(201).send({ ...found, review, needsReview: false });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/staff-logins/:id',
    { ...write, schema: { tags: ['Staff app'], description: 'Closes a staff login and signs them out on every phone.', params: idParam } },
    async (req, reply) => {
      const employee = employeeOf(req);
      const existed = await store.getStaffLogin(req.principal.orgId, employee.id);
      await store.deleteStaffLogin(req.principal.orgId, employee.id);
      audit(orgOf(req), actor(req), 'staff.login_closed', { employeeId: employee.id });
      // Only a login that was there is a close to review.
      if (existed) logLogin(orgOf(req), { employeeId: employee.id, kind: 'closed', by: actor(req) });
      return reply.code(204).send();
    },
  );
}

const pushBody = {
  type: 'object',
  required: ['endpoint'],
  properties: {
    endpoint: { type: 'string', maxLength: 1000 },
    keys: { type: 'object', required: ['p256dh', 'auth'], properties: { p256dh: { type: 'string', maxLength: 200 }, auth: { type: 'string', maxLength: 100 } } },
    label: { type: 'string', maxLength: 40 },
  },
  additionalProperties: false,
} as const;

/**
 * Notifications on the person's phone. The phone subscribes with this server's public key; the
 * subscription is kept on their login, so closing it, or marking them as a leaver, ends it too.
 */
function pushRoutes(app: FastifyInstance, store: Store) {
  app.get('/v1/staff/push', { schema: { hide: true } }, async (req) => {
    const { login } = await requireStaff(req, store);
    return { publicKey: (await vapidKeys(store)).publicKey, reminders: login.reminders !== false, devices: (login.push ?? []).map(({ endpoint, label, addedAt }) => ({ endpoint, label: label ?? null, addedAt })) };
  });

  app.post<{ Body: { endpoint: string; keys?: { p256dh: string; auth: string }; label?: string } }>(
    '/v1/staff/push/subscribe',
    { schema: { hide: true, body: pushBody } },
    async (req) => {
      const { org, employee, login } = await requireStaff(req, store);
      const { endpoint, keys, label } = req.body;
      if (!keys || !validEndpoint(endpoint)) throw new HttpError(422, 'invalid_subscription', 'This phone gave an address Preshift does not send to. Try again, or use another browser.');
      // A phone that subscribes again replaces itself; past five, the oldest goes.
      const others = (login.push ?? []).filter((d) => d.endpoint !== endpoint);
      const device: PushDevice = { endpoint, p256dh: keys.p256dh, auth: keys.auth, addedAt: new Date().toISOString(), ...(label?.trim() ? { label: label.trim() } : {}) };
      await store.putStaffLogin({ ...login, push: [...others, device].slice(-MAX_PUSH_DEVICES) });
      audit(org, `staff:${employee.id}`, 'staff.push_on', { employeeId: employee.id });
      await store.save(org);
      return { ok: true, devices: Math.min(others.length + 1, MAX_PUSH_DEVICES) };
    },
  );

  app.post<{ Body: { endpoint: string } }>(
    '/v1/staff/push/unsubscribe',
    { schema: { hide: true, body: { type: 'object', required: ['endpoint'], properties: { endpoint: { type: 'string', maxLength: 1000 } }, additionalProperties: false } } },
    async (req) => {
      const { org, employee, login } = await requireStaff(req, store);
      const push = (login.push ?? []).filter((d) => d.endpoint !== req.body.endpoint);
      if (push.length !== (login.push ?? []).length) {
        await store.putStaffLogin({ ...login, push });
        audit(org, `staff:${employee.id}`, 'staff.push_off', { employeeId: employee.id });
        await store.save(org);
      }
      return { ok: true, devices: push.length };
    },
  );

  // "Seen it": the person confirms their week as it now reads. A later change needs confirming again.
  app.post<{ Body: { weekStart: string } }>(
    '/v1/staff/rota/seen',
    { schema: { hide: true, body: { type: 'object', required: ['weekStart'], properties: { weekStart: { type: 'string', format: 'date' } }, additionalProperties: false } } },
    async (req) => {
      const staff = await requireStaff(req, store);
      const { org, employee } = staff;
      const at = new Date().toISOString();
      org.rotaSeen = pruneSeen(org.rotaSeen ?? {}, addDays(weekStart(londonParts(new Date()).date), -7 * 26));
      const confirmed = confirmWeek(org.toldWeeks ?? {}, org.rotaSeen, employee.id, req.body.weekStart, at);
      if (confirmed === 0) throw new HttpError(404, 'not_found', 'There is no published week of yours to confirm.');
      audit(org, `staff:${employee.id}`, 'rota.seen', { employeeId: employee.id, weekStart: req.body.weekStart });
      await store.save(org);
      return overview(staff, store);
    },
  );

  // Reminders the evening before and two hours before each shift. Not-clocked-in nudges are not optional.
  app.put<{ Body: { on: boolean } }>(
    '/v1/staff/reminders',
    { schema: { hide: true, body: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } }, additionalProperties: false } } },
    async (req) => {
      const { login } = await requireStaff(req, store);
      await store.putStaffLogin({ ...login, reminders: req.body.on });
      return { on: req.body.on };
    },
  );

  // So the person can see it works before they rely on it. Their own phones only.
  app.post('/v1/staff/push/test', { schema: { hide: true } }, async (req) => {
    const { employee, login } = await requireStaff(req, store);
    const devices = login.push ?? [];
    if (devices.length === 0) throw new HttpError(409, 'push_off', 'Notifications are not on for any of your phones yet.');
    const keys = await vapidKeys(store);
    const message = { title: 'Notifications are on', body: `Hello ${employee.name.split(' ')[0]}. This is how Preshift will tell you about your rota.`, url: '/staff/#inbox', tag: 'test' };
    const results = await Promise.all(devices.map((d) => sendPush(keys, d, message, pushSubject())));
    if (results.includes('gone')) await store.putStaffLogin({ ...login, push: devices.filter((_, i) => results[i] !== 'gone') });
    return { sent: results.filter((r) => r === 'sent').length, failed: results.filter((r) => r === 'failed').length, gone: results.filter((r) => r === 'gone').length };
  });
}
