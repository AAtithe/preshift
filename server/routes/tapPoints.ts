import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { idParam } from '../schemas';
import { audit, type OrgData, type Store, type TapPoint } from '../store';
import { readSun } from '../tagSun';

// Tap points: a secure NFC tag (NTAG 424 DNA) stuck by the staff entrance. Staff touch it with their
// own phone, which opens the staff app at an address the tag has just written, and they are clocked.
// The phone needs no app, no location and no Apple or Google wallet: the tag proves where, the staff
// login proves who. Each read carries a counter that only goes up, so a link copied or sent to a
// colleague at home is refused once anyone has tapped since, and never works twice.

interface TagSecret {
  /** AES-128 keys, hex: the one that encrypts the serial and counter, and the one that signs them. */
  meta: string;
  file: string;
  /** The highest read counter accepted. A read at or below it is a link used already. */
  counter: number;
  serial?: string;
}

const secretSetting = (orgId: string, id: string) => `tap_point:${orgId}:${id}`;

/** Where a tag sends the phone. The zeros are where the tag writes each read's PICC data and MAC. */
export const tagPath = (id: string) => `/staff/?tag=${id}&picc=${'0'.repeat(32)}&cmac=${'0'.repeat(16)}`;

const view = (t: TapPoint) => ({ ...t, tagSerial: t.tagSerial ?? null, lastTapAt: t.lastTapAt ?? null, path: tagPath(t.id) });

/**
 * Checks one read of a tag and records it, so the same read is never accepted again. Returns the
 * tap point, or refuses: an unknown tag, an address the tag did not write, or a read already used.
 */
export async function acceptTap(store: Store, org: OrgData, id: string, picc: string, cmac: string): Promise<TapPoint> {
  const point = (org.tapPoints ?? []).find((t) => t.id === id);
  const raw = point ? await store.getSetting(secretSetting(org.orgId, point.id)) : null;
  if (!point || !raw) throw new HttpError(404, 'unknown_tag', 'This tag is not set up for clocking. Ask your manager.');
  const secret = JSON.parse(raw) as TagSecret;
  const read = readSun(Buffer.from(secret.meta, 'hex'), Buffer.from(secret.file, 'hex'), picc, cmac);
  // A tag programmed with these keys but stuck somewhere else is still not this tag.
  if (!read || (secret.serial && read.uid !== secret.serial)) {
    throw new HttpError(403, 'tag_not_genuine', 'This tap could not be checked. Touch your phone to the tag again.');
  }
  if (read.counter <= secret.counter) {
    throw new HttpError(409, 'tap_used', 'This tap has been used already. Touch your phone to the tag again.');
  }
  await store.setSetting(secretSetting(org.orgId, point.id), JSON.stringify({ ...secret, counter: read.counter, serial: read.uid }));
  point.tagSerial = read.uid;
  point.lastTapAt = new Date().toISOString();
  return point;
}

export function tapPointRoutes(app: FastifyInstance, ctx: AppContext) {
  const setup = { preHandler: requireScope('rota:write') };

  app.get('/v1/tap-points', { ...setup, schema: { tags: ['Clocking'], description: 'Secure NFC tags staff tap with their phone, at the sites the caller manages the team.' } }, async (req) => {
    const org = orgOf(req);
    return (org.tapPoints ?? []).filter(guard(ctx, req, org).at('team.manage')).map(view);
  });

  app.post<{ Body: { siteId: string; name: string } }>(
    '/v1/tap-points',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description:
          'Adds a secure NFC tag (NTAG 424 DNA) at a site for staff to clock by touching it with their phone. Returns the two ' +
          'AES keys to program onto the tag and the address it should write, with Secure Unique NFC mirroring the serial and ' +
          'counter (PICC data) and the MAC. The keys are in this response only; a tag whose keys are lost is removed and added again.',
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
      // A tag clocks people in at the site, as a card reader does: the team's to manage, there.
      g.allow('team.manage', site.id);
      const point: TapPoint = { id: `tag_${randomUUID().slice(0, 12)}`, siteId: site.id, name: req.body.name.trim(), addedBy: actorName(g), addedAt: new Date().toISOString() };
      const secret: TagSecret = { meta: randomBytes(16).toString('hex'), file: randomBytes(16).toString('hex'), counter: -1 };
      await ctx.store.setSetting(secretSetting(org.orgId, point.id), JSON.stringify(secret));
      org.tapPoints = [...(org.tapPoints ?? []), point];
      audit(org, actorName(g), 'tap_point.added', { tapPointId: point.id, siteId: site.id, name: point.name });
      return reply.code(201).send({ tapPoint: view(point), keys: { metaRead: secret.meta.toUpperCase(), fileRead: secret.file.toUpperCase() } });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/tap-points/:id',
    { ...setup, schema: { tags: ['Clocking'], description: 'Removes a tag. Taps on it are refused at once.', params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const point = (org.tapPoints ?? []).find((t) => t.id === req.params.id);
      if (!point) throw notFound(`Tap point ${req.params.id}`);
      g.allow('team.manage', point.siteId);
      org.tapPoints = (org.tapPoints ?? []).filter((t) => t.id !== point.id);
      await ctx.store.setSetting(secretSetting(org.orgId, point.id), null);
      audit(org, actorName(g), 'tap_point.removed', { tapPointId: point.id, siteId: point.siteId, name: point.name });
      return reply.code(204).send();
    },
  );
}
