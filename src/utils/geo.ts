/**
 * Geospatial helpers.
 *
 * Distance search is implemented with the Haversine formula executed in PostgreSQL
 * (see `coach.service.ts`). No PostGIS/geography extension is required, which keeps
 * the deployment portable across managed PostgreSQL providers. `haversineDistanceKm`
 * below mirrors the SQL expression exactly and is unit-tested against known
 * city-to-city distances so the two implementations cannot silently drift.
 *
 * If you later need index-accelerated radius search at scale, PostGIS is the upgrade
 * path: `CREATE EXTENSION postgis;` plus a `geography(Point,4326)` column and a GiST
 * index. The README documents that migration.
 */

export const EARTH_RADIUS_KM = 6371;

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;
/** Upper bound for the `radius` filter. 20 000 km covers the whole planet. */
export const RADIUS_MAX_KM = 20_000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance in kilometres.
 *
 * Uses the numerically stable `2 * R * asin(sqrt(h))` form (the "haversine" form)
 * instead of `acos(...)`, which loses precision for very small distances.
 */
export function haversineDistanceKm(from: Coordinates, to: Coordinates): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const sinHalfLat = Math.sin(deltaLat / 2);
  const sinHalfLon = Math.sin(deltaLon / 2);

  const h = sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  const clamped = Math.min(1, Math.max(0, h));

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(clamped));
}

/** Round to 3 decimals (~1 m) to keep payloads small and stable. */
export function roundDistanceKm(distanceKm: number): number {
  return Math.round(distanceKm * 1000) / 1000;
}

/** Price and rating rounding helper used by presenters. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
