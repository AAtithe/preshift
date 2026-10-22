import type { FastifyInstance } from 'fastify';
import type { Site, SiteTravel } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { geocodePostcode, refreshTravel } from '../integrations/travel/journeys';
import { actorName, guard } from '../guard';
import { idParam } from '../schemas';
import { audit, type OrgData } from '../store';
import { replaceSite } from './clocking';

const locationBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    postcode: { type: 'string', minLength: 5, maxLength: 10 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lng: { type: 'number', minimum: -180, maximum: 180 },
  },
} as const;

const pairParams = {
  type: 'object',
  required: ['id', 'toId'],
  properties: { id: { type: 'string', minLength: 1 }, toId: { type: 'string', minLength: 1 } },
} as const;

/** Drops journeys to and from a site that were looked up or estimated, because it has moved. */
function forgetLookedUp(org: OrgData, siteId: string) {
  org.state.sites = org.state.sites.map((s) => {
    const kept = Object.entries(s.travel ?? {}).filter(([to, t]) => t.source === 'manual' || (s.id !== siteId && to !== siteId));
    return { ...s, travel: Object.fromEntries(kept) };
  });
}

/** Where each site is and how long it takes to get between them, for moves between sites in a day. */
export function travelRoutes(app: FastifyInstance, ctx: AppContext) {
  const write = { preHandler: requireScope('rota:write') };

  app.put<{ Params: { id: string }; Body: { postcode?: string; lat?: number; lng?: number } }>(
    '/v1/sites/:id/location',
    {
      ...write,
      schema: {
        tags: ['Travel'],
        description: 'Sets where a site is, from a UK postcode (looked up on postcodes.io) or coordinates. Looked-up journey times to and from it are cleared; refresh them after.',
        params: idParam,
        body: locationBody,
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Where a site is and how long it takes to reach the others decides what the rota allows:
      // site set-up, as the clocking area is.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const { postcode, lat, lng } = req.body;
      let location: Site['location'];
      if (lat !== undefined && lng !== undefined) {
        location = { lat, lng, ...(postcode ? { postcode: postcode.toUpperCase() } : {}) };
      } else if (postcode) {
        location = (await geocodePostcode(postcode, ctx.fetch)) ?? undefined;
        if (!location) throw new HttpError(422, 'unknown_postcode', `${postcode.toUpperCase()} is not a current UK postcode.`);
      } else {
        throw new HttpError(422, 'location_required', 'Give a postcode, or a latitude and longitude.');
      }
      replaceSite(org, req.params.id, (s) => ({ ...s, location }));
      forgetLookedUp(org, req.params.id);
      audit(org, actorName(g), 'site.location_set', { siteId: req.params.id, ...location });
      return org.state.sites.find((s) => s.id === req.params.id);
    },
  );

  app.post(
    '/v1/sites/travel/refresh',
    {
      ...write,
      schema: {
        tags: ['Travel'],
        description:
          'Plans the quickest public transport or walking journey between every pair of located sites, each way, with the TfL journey planner for a weekday at 17:00. Times set by hand are kept; where TfL has no answer a straight-line estimate is stored and labelled.',
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Where a site is and how long it takes to reach the others decides what the rota allows:
      // site set-up, as the clocking area is.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const today = londonParts(new Date()).date;
      const result = await refreshTravel(org.state.sites, ctx.fetch, today, ctx.tflAppKey);
      org.state.sites = result.sites;
      audit(org, actorName(g), 'site.travel_refreshed', { fromTfl: result.fromTfl, estimated: result.estimated });
      return { sites: org.state.sites, fromTfl: result.fromTfl, estimated: result.estimated, failures: result.failures };
    },
  );

  app.put<{ Params: { id: string; toId: string }; Body: { minutes: number } }>(
    '/v1/sites/:id/travel/:toId',
    {
      ...write,
      schema: {
        tags: ['Travel'],
        description: 'Sets the journey time between two sites by hand, both ways. A refresh keeps it.',
        params: pairParams,
        body: { type: 'object', required: ['minutes'], additionalProperties: false, properties: { minutes: { type: 'integer', minimum: 0, maximum: 240 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Where a site is and how long it takes to reach the others decides what the rota allows:
      // site set-up, as the clocking area is.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const { id, toId } = req.params;
      if (id === toId) throw new HttpError(422, 'same_site', 'Choose two different sites.');
      if (!org.state.sites.some((s) => s.id === toId)) throw notFound(`Site ${toId}`);
      const checkedAt = londonParts(new Date()).date;
      const entry: SiteTravel = { minutes: req.body.minutes, source: 'manual', checkedAt };
      replaceSite(org, id, (s) => ({ ...s, travel: { ...(s.travel ?? {}), [toId]: entry } }));
      replaceSite(org, toId, (s) => ({ ...s, travel: { ...(s.travel ?? {}), [id]: entry } }));
      audit(org, actorName(g), 'site.travel_set', { siteId: id, toSiteId: toId, minutes: req.body.minutes });
      return org.state.sites;
    },
  );

  app.delete<{ Params: { id: string; toId: string } }>(
    '/v1/sites/:id/travel/:toId',
    { ...write, schema: { tags: ['Travel'], description: 'Removes a hand-set journey time both ways, so the next refresh looks it up.', params: pairParams } },
    async (req) => {
      const org = orgOf(req);
      // Where a site is and how long it takes to reach the others decides what the rota allows:
      // site set-up, as the clocking area is.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const { id, toId } = req.params;
      const drop = (s: Site, other: string) => {
        const { [other]: _gone, ...rest } = s.travel ?? {};
        return { ...s, travel: rest };
      };
      replaceSite(org, id, (s) => drop(s, toId));
      if (org.state.sites.some((s) => s.id === toId)) replaceSite(org, toId, (s) => drop(s, id));
      audit(org, actorName(g), 'site.travel_cleared', { siteId: id, toSiteId: toId });
      return org.state.sites;
    },
  );
}
