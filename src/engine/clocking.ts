import type { GeoFence, GeoFix } from './types';

const EARTH_RADIUS_METRES = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres (haversine). */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h));
}

/** A fix vaguer than this cannot place someone at a site, so it is refused rather than guessed at. */
export const MAX_ACCURACY_METRES = 250;

export type FenceCheck =
  | { ok: true; distanceMetres: number }
  | { ok: false; reason: 'too_imprecise' | 'outside_site'; distanceMetres: number };

/**
 * Whether a device is at the site. Phones indoors often report a fix 20 to 80 metres out, so
 * the fix's own accuracy is allowed on top of the radius, but never more than the radius
 * again: a fence of 100 metres accepts at most 200 metres from the centre.
 */
export function checkFence(fence: GeoFence, fix: GeoFix): FenceCheck {
  const distance = Math.round(distanceMetres(fence, fix));
  if (!(fix.accuracyMetres <= MAX_ACCURACY_METRES)) return { ok: false, reason: 'too_imprecise', distanceMetres: distance };
  const allowance = Math.min(fix.accuracyMetres, fence.radiusMetres);
  return distance <= fence.radiusMetres + allowance
    ? { ok: true, distanceMetres: distance }
    : { ok: false, reason: 'outside_site', distanceMetres: distance };
}

/**
 * One spelling per card. USB readers type the UID as digits or hex, and phones read it as
 * colon-separated hex ("04:a2:3f:..."), so separators and case are dropped. Use the same kind
 * of reader to enrol a card as to tap it: a decimal and a hex reading of one card differ.
 */
export function normaliseBadge(raw: string): string {
  return raw.replace(/[^0-9a-z]/gi, '').toUpperCase();
}
