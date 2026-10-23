import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Employee, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { idParam } from '../schemas';
import { cookieFrom, KIOSK_COOKIE, kioskCookie, sessionCookie } from '../session';
import { audit, type Kiosk, type OrgData, type Store } from '../store';
import { secure } from './access';
import { checkPin, clearPin, issuePin } from '../kioskPin';
import { replaceSite, tapCard } from './clocking';
import { clockIn, clockOut, endBreak, onBreak, startBreak } from './time';

// The kiosk: a shared iPad at one site's staff entrance that can clock people in and out and do
// nothing else. A manager turns the iPad into a kiosk while signed in on it, in person, and is
// signed out in the same step; from then on the iPad holds only the kiosk's own credential, which
// reaches today's board for that one site and the clocking actions below. It cannot read pay, HR,
// the rota beyond today, or any other site.

const secretSetting = (orgId: string, kioskId: string) => `kiosk_secret:${orgId}:${kioskId}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const SEEN_EVERY_MS = 10 * 60_000;

const encode = (v: { o: string; k: string; s: string }) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(raw: string | null): { o: string; k: string; s: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof v?.o === 'string' && typeof v?.k === 'string' && typeof v?.s === 'string' ? v : null;
  } catch {
    return null;
  }
}

interface Paired {
  org: OrgData;
  kiosk: Kiosk;
}

/** The kiosk behind a request, checked against the database every time, or null. */
async function kioskOf(req: FastifyRequest, store: Store): Promise<Paired | null> {
  const claim = decode(cookieFrom(req.headers.cookie, KIOSK_COOKIE));
  // has() first: a made-up cookie must never create an organisation, as load() would.
  if (!claim || !(await store.has(claim.o))) return null;
  const hash = await store.getSetting(secretSetting(claim.o, claim.k));
  if (!hash || !sameHash(hash, sha256(claim.s))) return null;
  const org = await store.load(claim.o);
  const kiosk = (org.kiosks ?? []).find((k) => k.id === claim.k);
  if (!kiosk || !org.state.sites.some((s) => s.id === kiosk.siteId)) return null;
  return { org, kiosk };
}

async function requireKiosk(req: FastifyRequest, store: Store): Promise<Paired> {
  const paired = await kioskOf(req, store);
  if (!paired) throw new HttpError(401, 'not_paired', 'This iPad is not set up as a kiosk.');
  return paired;
}

type Status = 'not_in' | 'in' | 'break' | 'out' | 'elsewhere';

/** Who the kiosk can clock by name: today's rota at its site, and anyone clocked in there now. */
function board({ org, kiosk }: Paired) {
  const { date } = londonParts(new Date());
  const site = org.state.sites.find((s) => s.id === kiosk.siteId)!;
  const shifts = org.state.shifts.filter((s) => s.siteId === site.id && s.date === date).sort((a, b) => a.startMinute - b.startMinute);
  const openHere = org.timeEntries.filter((t) => t.status === 'open' && t.siteId === site.id);
  const ids = [...shifts.map((s) => s.employeeId), ...openHere.map((t) => t.employeeId)].filter((id, i, all) => all.indexOf(id) === i);
  const people = ids
    .map((id) => org.state.employees.find((e) => e.id === id))
    .filter((e): e is Employee => Boolean(e) && e!.status !== 'leaver')
    .map((e) => {
      const shift = shifts.find((s) => s.employeeId === e.id);
      const open = org.timeEntries.find((t) => t.employeeId === e.id && t.status === 'open');
      const doneHere = org.timeEntries.filter((t) => t.employeeId === e.id && t.siteId === site.id && t.date === date && t.status !== 'open');
      const status: Status = open
        ? open.siteId !== site.id ? 'elsewhere' : onBreak(open) ? 'break' : 'in'
        : doneHere.length ? 'out' : 'not_in';
      const since = open ? (onBreak(open) ? open.breaks!.at(-1)!.start : open.clockIn) : doneHere.at(-1)?.clockOut;
      return {
        id: e.id,
        name: e.name,
        role: shift ? org.state.roles.find((r) => r.id === shift.roleId)?.name ?? null : null,
        shift: shift ? { start: shift.startMinute, end: shift.endMinute } : null,
        status,
        since: since ?? null,
        hasPin: Boolean(e.kioskPinSetAt),
      };
    });
  return { kiosk: { name: kiosk.name }, site: { id: site.id, name: site.name }, today: date, pinRequired: Boolean(site.kioskPinRequired), people };
}

const firstName = (name: string) => name.split(' ')[0];

export function kioskRoutes(app: FastifyInstance, ctx: AppContext) {
  const store = ctx.store;
  const hidden = { schema: { hide: true } };
  const who = (kiosk: Kiosk) => `Kiosk ${kiosk.name}`;

  app.get('/v1/kiosk/board', hidden, async (req) => {
    const paired = await requireKiosk(req, store);
    // Last seen tells a manager the iPad is alive; kept at most every few minutes.
    const seen = paired.kiosk.lastSeenAt ? Date.parse(paired.kiosk.lastSeenAt) : 0;
    if (Date.now() - seen > SEEN_EVERY_MS) {
      paired.kiosk.lastSeenAt = new Date().toISOString();
      await store.save(paired.org).catch(() => undefined);
    }
    return board(paired);
  });

  // A card on the kiosk's reader. The kiosk is fixed at its site, so the card needs no location.
  app.post<{ Body: { badgeId: string } }>(
    '/v1/kiosk/tap',
    { schema: { hide: true, body: { type: 'object', required: ['badgeId'], properties: { badgeId: { type: 'string', minLength: 1 } } } } },
    async (req) => {
      const paired = await requireKiosk(req, store);
      const result = tapCard(paired.org, paired.kiosk.siteId, req.body.badgeId, { fixedReader: true });
      if (!result.action.startsWith('already')) {
        audit(paired.org, who(paired.kiosk), `time.kiosk_${result.action}`, { id: result.entry.id, employeeId: result.employee.id });
        await store.save(paired.org);
      }
      return { action: result.action, name: firstName(result.employee.name), entry: result.entry, board: board(paired) };
    },
  );

  // Signing in by name, for someone without their card. Only people on today's rota at this site,
  // or already clocked in here, can be clocked from the kiosk.
  app.post<{ Body: { employeeId: string; action: 'in' | 'out' | 'break_start' | 'break_end'; pin?: string } }>(
    '/v1/kiosk/clock',
    {
      schema: {
        hide: true,
        body: {
          type: 'object',
          required: ['employeeId', 'action'],
          properties: {
            employeeId: { type: 'string' },
            action: { type: 'string', enum: ['in', 'out', 'break_start', 'break_end'] },
            pin: { type: 'string', maxLength: 12 },
          },
        },
      },
    },
    async (req) => {
      const paired = await requireKiosk(req, store);
      const { org, kiosk } = paired;
      const person = board(paired).people.find((p) => p.id === req.body.employeeId);
      const employee = org.state.employees.find((e) => e.id === req.body.employeeId);
      const site = org.state.sites.find((s) => s.id === kiosk.siteId)!;
      if (!person || !employee) {
        throw new HttpError(403, 'not_on_rota', `Only people on today's rota at ${site.name} can sign in here by name. Use your card, or ask a manager.`);
      }
      // Where the site asks for it, a name alone is not enough: anyone at the iPad can tap a colleague's name.
      if (site.kioskPinRequired) await checkPin(store, org.orgId, employee, req.body.pin);
      const open = org.timeEntries.find((t) => t.employeeId === employee.id && t.status === 'open');
      const needOpen = (): TimeEntry => {
        if (!open) throw new HttpError(409, 'not_clocked_in', `${firstName(employee.name)}, you are not clocked in.`);
        return open;
      };
      let entry: TimeEntry;
      switch (req.body.action) {
        case 'in':
          entry = clockIn(org, employee, site.id, { method: 'kiosk' });
          break;
        case 'out':
          entry = clockOut(org, needOpen(), { method: 'kiosk' });
          break;
        case 'break_start':
          entry = startBreak(needOpen());
          break;
        case 'break_end':
          entry = endBreak(needOpen());
          break;
      }
      audit(org, who(kiosk), `time.kiosk_${req.body.action}`, { id: entry.id, employeeId: employee.id, byName: true });
      await store.save(org);
      return { action: req.body.action, name: firstName(employee.name), entry, board: board(paired) };
    },
  );
}

/** Managers pair and remove kiosks. Registered inside the authenticated API. */
export function kioskAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const setup = { preHandler: requireScope('rota:write') };
  const view = (k: Kiosk) => ({ id: k.id, siteId: k.siteId, name: k.name, pairedBy: k.pairedBy, pairedAt: k.pairedAt, lastSeenAt: k.lastSeenAt ?? null });

  app.get('/v1/kiosks', { ...setup, schema: { tags: ['Clocking'], description: 'Paired clocking kiosks at the sites the caller manages the team.' } }, async (req) => {
    const org = orgOf(req);
    return (org.kiosks ?? []).filter(guard(ctx, req, org).at('team.manage')).map(view);
  });

  app.post<{ Body: { siteId: string; name: string } }>(
    '/v1/kiosks',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description:
          'Turns the device making the request into a clocking kiosk for one site. Only from a signed-in session on the device ' +
          'itself: the response gives the device its kiosk credential, valid for a year, and signs the person out of it.',
        body: {
          type: 'object',
          required: ['siteId', 'name'],
          additionalProperties: false,
          properties: { siteId: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const site = org.state.sites.find((s) => s.id === req.body.siteId);
      if (!site) throw notFound(`Site ${req.body.siteId}`);
      g.allow('team.manage', site.id);
      // A key has no device to pair: the credential would go to whatever holds the key.
      if (!req.principal.email) {
        throw new HttpError(403, 'session_only', 'Pair a kiosk on the iPad itself: sign in to Preshift there and choose Turn this iPad into a kiosk.');
      }
      const kiosk: Kiosk = { id: `ksk_${randomUUID().slice(0, 12)}`, siteId: site.id, name: req.body.name.trim(), pairedBy: actorName(g), pairedAt: new Date().toISOString() };
      const secret = randomBytes(32).toString('base64url');
      await ctx.store.setSetting(secretSetting(org.orgId, kiosk.id), sha256(secret));
      org.kiosks = [...(org.kiosks ?? []), kiosk];
      audit(org, actorName(g), 'kiosk.paired', { kioskId: kiosk.id, siteId: site.id, name: kiosk.name });
      // The kiosk credential in, the person's session out: a shared iPad must never stay signed in as a manager.
      reply.header('set-cookie', [kioskCookie(encode({ o: org.orgId, k: kiosk.id, s: secret }), secure(req)), sessionCookie('', secure(req), 0)]);
      return reply.code(201).send({ kiosk: view(kiosk), path: '/kiosk/' });
    },
  );

  app.put<{ Params: { id: string }; Body: { required: boolean } }>(
    '/v1/sites/:id/kiosk-pin',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description: "Whether signing in by name on the site's kiosk needs the person's PIN. Cards are never affected.",
        params: idParam,
        body: { type: 'object', required: ['required'], additionalProperties: false, properties: { required: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!org.state.sites.some((s) => s.id === req.params.id)) throw notFound(`Site ${req.params.id}`);
      g.allow('team.manage', req.params.id);
      const site = replaceSite(org, req.params.id, (s) => ({ ...s, kioskPinRequired: req.body.required }));
      audit(org, actorName(g), req.body.required ? 'kiosk.pin_required' : 'kiosk.pin_not_required', { siteId: site.id });
      return site;
    },
  );

  const employeeOf = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const employee = org.state.employees.find((e) => e.id === req.params.id);
    if (!employee) throw notFound(`Employee ${req.params.id}`);
    g.allow('team.manage', employee.siteId);
    return { org, g, employee };
  };

  app.post<{ Params: { id: string } }>(
    '/v1/employees/:id/kiosk-pin',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description:
          "Issues the person a new random kiosk PIN, replacing any they had, for a manager to hand over. The PIN is in this " +
          'response only and is never stored in the clear. People can also choose their own in the staff app.',
        params: idParam,
      },
    },
    async (req, reply) => {
      const { org, g, employee } = employeeOf(req);
      if (employee.status === 'leaver') throw new HttpError(409, 'leaver', `${employee.name} has left.`);
      const pin = await issuePin(ctx.store, org.orgId, employee);
      audit(org, actorName(g), 'kiosk.pin_issued', { employeeId: employee.id });
      return reply.code(201).send({ pin, setAt: employee.kioskPinSetAt });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/employees/:id/kiosk-pin',
    { ...setup, schema: { tags: ['Clocking'], description: "Removes the person's kiosk PIN.", params: idParam } },
    async (req, reply) => {
      const { org, g, employee } = employeeOf(req);
      await clearPin(ctx.store, org.orgId, employee);
      audit(org, actorName(g), 'kiosk.pin_removed', { employeeId: employee.id });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/kiosks/:id',
    { ...setup, schema: { tags: ['Clocking'], description: 'Removes a kiosk. The iPad stops working at once.', params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const kiosk = (org.kiosks ?? []).find((k) => k.id === req.params.id);
      if (!kiosk) throw notFound(`Kiosk ${req.params.id}`);
      g.allow('team.manage', kiosk.siteId);
      org.kiosks = (org.kiosks ?? []).filter((k) => k.id !== kiosk.id);
      await ctx.store.setSetting(secretSetting(org.orgId, kiosk.id), null);
      audit(org, actorName(g), 'kiosk.removed', { kioskId: kiosk.id, siteId: kiosk.siteId, name: kiosk.name });
      return reply.code(204).send();
    },
  );
}

