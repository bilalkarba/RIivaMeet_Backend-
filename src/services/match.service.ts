import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ExperienceLevel } from '../generated/prisma/enums.js';
import type { SuggestionsQuery } from '../schemas/profile.schema.js';
import { APPROVED_VERIFICATION_CONDITION } from './coach.service.js';
import type { AuthenticatedUser } from '../utils/jwt.js';
import { roundDistanceKm, roundTo } from '../utils/geo.js';
import {
  toCoachSummary,
  type CoachProfileLike,
  type CoachSummaryResponse,
  type SportSummary,
} from '../utils/presenters.js';

/**
 * Compatible-profile suggestions (Phase 1).
 *
 * Unlike `searchCoaches`, this endpoint is personalised: the signed-in viewer's own
 * disciplines, level and location (city/country) drive a relevance score, so an athlete
 * sees the coaches most likely to fit them first. Everything is computed and paginated
 * in a single parameterized SQL statement; no user input is concatenated into SQL.
 *
 * Callers pass `excludeUserIds` (users the viewer blocked or who blocked the viewer) so
 * blocked accounts never surface in discovery.
 */

const EARTH_RADIUS_KM = 6371;

interface RawSuggestionRow {
  coach_profile_id: string;
  user_id: string;
  coach_name: string;
  bio: string;
  certifications: string[];
  hourly_price: string;
  experience_level: ExperienceLevel;
  city: string;
  neighborhood: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  is_published: boolean;
  created_at: Date;
  updated_at: Date;
  avg_rating: number;
  review_count: number;
  distance_km: number | null;
  relevance_score: number;
}

export interface SuggestionResult {
  coaches: CoachSummaryResponse[];
  total: number;
  /** How the ranking was personalised, so clients can explain the results. */
  basis: {
    sports: string[];
    level: ExperienceLevel | null;
    city: string | null;
    country: string | null;
  };
}

export async function suggestCompatibleCoaches(
  viewer: AuthenticatedUser,
  query: SuggestionsQuery,
  options: { excludeUserIds?: string[] } = {},
): Promise<SuggestionResult> {
  const excludeUserIds = options.excludeUserIds ?? [];

  const [profile, viewerSports] = await Promise.all([
    prisma.user.findUnique({
      where: { id: viewer.id },
      select: { city: true, country: true, level: true },
    }),
    prisma.userSport.findMany({ where: { userId: viewer.id }, select: { sportId: true } }),
  ]);

  const viewerSportIds = viewerSports.map((row) => row.sportId);
  // Explicit query filters win over the viewer's stored profile.
  const city = query.city ?? profile?.city ?? null;
  const country = query.country ?? profile?.country ?? null;
  const level = query.level ?? profile?.level ?? null;

  const hasCoordinates = query.latitude !== undefined && query.longitude !== undefined;

  // Same discovery gate as `searchCoaches`: an unverified coach is never suggested.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`cp.is_published = true`,
    APPROVED_VERIFICATION_CONDITION,
    Prisma.sql`cp.user_id <> ${viewer.id}`,
  ];

  if (excludeUserIds.length > 0) {
    conditions.push(Prisma.sql`cp.user_id NOT IN (${Prisma.join(excludeUserIds)})`);
  }

  if (query.sport) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM coach_sports cs
      JOIN sports s ON s.id = cs.sport_id
      WHERE cs.coach_profile_id = cp.id
        AND (s.slug = ${query.sport.trim().toLowerCase()} OR s.name ILIKE ${query.sport.trim()})
    )`);
  }

  if (query.level !== undefined) {
    conditions.push(Prisma.sql`cp.experience_level = ${query.level}::"ExperienceLevel"`);
  }

  if (city) {
    conditions.push(Prisma.sql`cp.city ILIKE ${city}`);
  }

  if (country) {
    conditions.push(Prisma.sql`u.country ILIKE ${country}`);
  }

  const scoreParts: Prisma.Sql[] = [];
  if (viewerSportIds.length > 0) {
    scoreParts.push(Prisma.sql`CASE WHEN EXISTS (
      SELECT 1 FROM coach_sports csm
      WHERE csm.coach_profile_id = cp.id
        AND csm.sport_id IN (${Prisma.join(viewerSportIds)})
    ) THEN 3 ELSE 0 END`);
  }
  if (city) {
    scoreParts.push(Prisma.sql`CASE WHEN cp.city ILIKE ${city} THEN 2 ELSE 0 END`);
  }
  if (country) {
    scoreParts.push(Prisma.sql`CASE WHEN u.country ILIKE ${country} THEN 1 ELSE 0 END`);
  }
  if (level) {
    scoreParts.push(Prisma.sql`CASE WHEN cp.experience_level = ${level}::"ExperienceLevel" THEN 1 ELSE 0 END`);
  }
  if (scoreParts.length === 0) {
    scoreParts.push(Prisma.sql`0`);
  }
  const scoreExpression = Prisma.sql`(${Prisma.join(scoreParts, ' + ')})::int`;

  const distanceExpression = hasCoordinates
    ? Prisma.sql`(2 * ${EARTH_RADIUS_KM} * asin(sqrt(
        power(sin(radians(cp.latitude - ${query.latitude}) / 2), 2)
        + cos(radians(${query.latitude})) * cos(radians(cp.latitude))
          * power(sin(radians(cp.longitude - ${query.longitude}) / 2), 2)
      )))`
    : Prisma.sql`NULL::float8`;

  const baseQuery = Prisma.sql`
    SELECT
      cp.id AS coach_profile_id,
      cp.user_id AS user_id,
      u.name AS coach_name,
      cp.bio AS bio,
      cp.certifications AS certifications,
      cp.hourly_price AS hourly_price,
      cp.experience_level AS experience_level,
      cp.city AS city,
      cp.neighborhood AS neighborhood,
      cp.address AS address,
      cp.latitude AS latitude,
      cp.longitude AS longitude,
      cp.is_published AS is_published,
      cp.created_at AS created_at,
      cp.updated_at AS updated_at,
      COALESCE(agg.avg_rating, 0)::float8 AS avg_rating,
      COALESCE(agg.review_count, 0)::int AS review_count,
      ${distanceExpression} AS distance_km,
      ${scoreExpression} AS relevance_score
    FROM coach_profiles cp
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN (
      SELECT r.coach_profile_id AS coach_profile_id,
             AVG(r.rating)::float8 AS avg_rating,
             COUNT(*)::int AS review_count
      FROM reviews r
      GROUP BY r.coach_profile_id
    ) AS agg ON agg.coach_profile_id = cp.id
    WHERE ${Prisma.join(conditions, ' AND ')}
  `;

  const outerFilter =
    query.radiusKm !== undefined ? Prisma.sql`WHERE c.distance_km <= ${query.radiusKm}` : Prisma.empty;
  const offset = (query.page - 1) * query.limit;

  const [countRows, rows] = await Promise.all([
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total FROM (${baseQuery}) AS c ${outerFilter}
    `),
    prisma.$queryRaw<RawSuggestionRow[]>(Prisma.sql`
      SELECT c.* FROM (${baseQuery}) AS c
      ${outerFilter}
      ORDER BY c.relevance_score DESC, c.avg_rating DESC, c.review_count DESC, c.created_at DESC, c.coach_profile_id ASC
      LIMIT ${query.limit} OFFSET ${offset}
    `),
  ]);

  const coachIds = rows.map((row) => row.coach_profile_id);
  const sportsByCoachId = await loadSportsByCoachId(coachIds);

  const coaches = rows.map((row) =>
    toCoachSummary(toProfileLike(row, sportsByCoachId.get(row.coach_profile_id) ?? []), {
      averageRating: row.review_count > 0 ? roundTo(row.avg_rating, 2) : null,
      reviewCount: row.review_count,
      distanceKm: row.distance_km === null ? null : roundDistanceKm(row.distance_km),
    }),
  );

  const viewerSportNames = await loadSportNames(viewerSportIds);

  return {
    coaches,
    total: countRows[0]?.total ?? 0,
    basis: { sports: viewerSportNames, level: profile?.level ?? null, city: profile?.city ?? null, country: profile?.country ?? null },
  };
}

async function loadSportsByCoachId(
  coachIds: string[],
): Promise<Map<string, { sport: SportSummary }[]>> {
  const map = new Map<string, { sport: SportSummary }[]>();
  if (coachIds.length === 0) {
    return map;
  }

  const rows = await prisma.coachSport.findMany({
    where: { coachProfileId: { in: coachIds } },
    include: { sport: { select: { id: true, name: true, slug: true } } },
  });

  for (const row of rows) {
    const bucket = map.get(row.coachProfileId) ?? [];
    bucket.push({ sport: { id: row.sport.id, name: row.sport.name, slug: row.sport.slug } });
    map.set(row.coachProfileId, bucket);
  }
  return map;
}

async function loadSportNames(sportIds: string[]): Promise<string[]> {
  if (sportIds.length === 0) {
    return [];
  }
  const rows = await prisma.sport.findMany({ where: { id: { in: sportIds } }, select: { name: true } });
  return rows.map((row) => row.name).sort((a, b) => a.localeCompare(b));
}

function toProfileLike(row: RawSuggestionRow, sports: { sport: SportSummary }[]): CoachProfileLike {
  return {
    id: row.coach_profile_id,
    userId: row.user_id,
    bio: row.bio,
    certifications: row.certifications,
    hourlyPrice: row.hourly_price,
    experienceLevel: row.experience_level,
    city: row.city,
    neighborhood: row.neighborhood,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    isPublished: row.is_published,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: { id: row.user_id, name: row.coach_name },
    sports,
  };
}
