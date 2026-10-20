import { prisma } from '../config/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { BookingStatus, VerificationStatus } from '../generated/prisma/enums.js';
import type { ExperienceLevel } from '../generated/prisma/enums.js';
import type {
  CreateAvailabilityBody,
  CreateCoachProfileBody,
  CoachSort,
  SearchCoachesQuery,
  UpdateCoachProfileBody,
} from '../schemas/coach.schema.js';
import { ApiError } from '../utils/errors.js';
import { roundDistanceKm, roundTo } from '../utils/geo.js';
import { isUniqueConstraintViolation } from '../utils/prisma-helpers.js';
import {
  toCoachDetail,
  toCoachSummary,
  type AvailabilitySlot,
  type CoachDetailResponse,
  type CoachProfileLike,
  type CoachSummaryResponse,
  type SportSummary,
} from '../utils/presenters.js';
import { resolveSportsByIdentifiers } from './sport.service.js';

/**
 * Coach profile, catalogue and search service.
 *
 * Geospatial search runs as a single parameterized SQL statement (Haversine) instead
 * of PostGIS. See `utils/geo.ts` for the rationale and the PostGIS upgrade path.
 */

const COACH_PROFILE_INCLUDE = {
  user: { select: { id: true, name: true } },
  sports: { include: { sport: { select: { id: true, name: true, slug: true } } } },
  availability: { orderBy: { startAt: 'asc' } },
} as const;

/** Rating is always derived from reviews - never stored. */
export async function getRatingSummary(
  coachProfileId: string,
): Promise<{ averageRating: number | null; reviewCount: number }> {
  const aggregate = await prisma.review.aggregate({
    where: { coachProfileId },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const reviewCount = aggregate._count._all;
  return {
    averageRating: reviewCount > 0 && aggregate._avg.rating !== null ? roundTo(aggregate._avg.rating, 2) : null,
    reviewCount,
  };
}

export async function getMyCoachProfile(userId: string): Promise<CoachDetailResponse> {
  const coach = await prisma.coachProfile.findUnique({
    where: { userId },
    include: { ...COACH_PROFILE_INCLUDE, _count: { select: { bookings: true } } },
  });

  if (!coach) {
    throw ApiError.notFound('You do not have a coach profile yet. Create one with POST /api/v1/coaches/me/profile');
  }

  const metrics = await getRatingSummary(coach.id);
  return toCoachDetail(coach, { ...metrics, distanceKm: undefined });
}

export async function createCoachProfile(
  userId: string,
  input: CreateCoachProfileBody,
): Promise<CoachDetailResponse> {
  if (input.isPublished) {
    throw ApiError.badRequest(
      'A brand new profile cannot be published immediately. Create it, add at least one sport, then publish it with PATCH /api/v1/coaches/me/profile',
      { hint: 'Publishing requires at least one sport and valid coordinates.' },
    );
  }

  const existing = await prisma.coachProfile.findUnique({ where: { userId }, select: { id: true } });
  if (existing) {
    throw ApiError.conflict('A coach profile already exists for this account. Use PATCH /api/v1/coaches/me/profile');
  }

  try {
    const coach = await prisma.coachProfile.create({
      data: {
        userId,
        bio: input.bio,
        certifications: input.certifications ?? [],
        hourlyPrice: new Prisma.Decimal(input.hourlyPrice),
        experienceLevel: input.experienceLevel,
        city: input.city,
        neighborhood: input.neighborhood,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        // A profile cannot be published before it lists at least one sport.
        isPublished: false,
      },
      include: { ...COACH_PROFILE_INCLUDE, _count: { select: { bookings: true } } },
    });

    return toCoachDetail(coach, { averageRating: null, reviewCount: 0, distanceKm: undefined });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw ApiError.conflict('A coach profile already exists for this account');
    }
    throw error;
  }
}

export async function updateCoachProfile(
  userId: string,
  input: UpdateCoachProfileBody,
): Promise<CoachDetailResponse> {
  const existing = await prisma.coachProfile.findUnique({
    where: { userId },
    select: { id: true, latitude: true, longitude: true, isPublished: true, _count: { select: { sports: true } } },
  });

  if (!existing) {
    throw ApiError.notFound('You do not have a coach profile yet. Create one with POST /api/v1/coaches/me/profile');
  }

  const nextLatitude = input.latitude === undefined ? existing.latitude : input.latitude;
  const nextLongitude = input.longitude === undefined ? existing.longitude : input.longitude;
  const nextIsPublished = input.isPublished ?? existing.isPublished;

  assertPublishable({
    isPublished: nextIsPublished,
    latitude: nextLatitude ?? undefined,
    longitude: nextLongitude ?? undefined,
    sportCount: existing._count.sports,
  });

  const coach = await prisma.coachProfile.update({
    where: { id: existing.id },
    data: {
      ...(input.bio === undefined ? {} : { bio: input.bio }),
      ...(input.certifications === undefined ? {} : { certifications: input.certifications }),
      ...(input.hourlyPrice === undefined ? {} : { hourlyPrice: new Prisma.Decimal(input.hourlyPrice) }),
      ...(input.experienceLevel === undefined ? {} : { experienceLevel: input.experienceLevel }),
      ...(input.city === undefined ? {} : { city: input.city }),
      ...(input.neighborhood === undefined ? {} : { neighborhood: input.neighborhood }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
      ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
      ...(input.isPublished === undefined ? {} : { isPublished: input.isPublished }),
    },
    include: { ...COACH_PROFILE_INCLUDE, _count: { select: { bookings: true } } },
  });

  const metrics = await getRatingSummary(coach.id);
  return toCoachDetail(coach, { ...metrics, distanceKm: undefined });
}

/**
 * Replaces the coach's sport list with the supplied set (idempotent).
 * Unknown sports produce a 400 listing exactly which values were not recognised.
 */
export async function replaceMySports(
  userId: string,
  input: { sportIds?: string[]; sportSlugs?: string[] },
): Promise<SportSummary[]> {
  const coachProfileId = await requireCoachProfileId(userId);
  const sports = await resolveSportsByIdentifiers(input);

  await prisma.$transaction(async (tx) => {
    await tx.coachSport.deleteMany({
      where: { coachProfileId, sportId: { notIn: sports.map((sport) => sport.id) } },
    });
    await tx.coachSport.createMany({
      data: sports.map((sport) => ({ coachProfileId, sportId: sport.id })),
      skipDuplicates: true,
    });
  });

  return listMySports(userId);
}

export async function addMySport(userId: string, input: { sportId: string }): Promise<SportSummary[]> {
  const coachProfileId = await requireCoachProfileId(userId);
  const [sport] = await resolveSportsByIdentifiers({ sportIds: [input.sportId] });

  if (!sport) {
    throw ApiError.badRequest('Unknown sport');
  }

  await prisma.coachSport.upsert({
    where: { coachProfileId_sportId: { coachProfileId, sportId: sport.id } },
    create: { coachProfileId, sportId: sport.id },
    update: {},
  });

  return listMySports(userId);
}

export async function removeMySport(userId: string, sportId: string): Promise<SportSummary[]> {
  const coachProfileId = await requireCoachProfileId(userId);

  const existing = await prisma.coachSport.findUnique({
    where: { coachProfileId_sportId: { coachProfileId, sportId } },
    select: { sportId: true },
  });

  if (!existing) {
    throw ApiError.notFound('This sport is not part of your profile');
  }

  await prisma.coachSport.delete({ where: { coachProfileId_sportId: { coachProfileId, sportId } } });
  return listMySports(userId);
}

export async function listMySports(userId: string): Promise<SportSummary[]> {
  const coachProfileId = await findCoachProfileId(userId);
  if (!coachProfileId) {
    return [];
  }

  const rows = await prisma.coachSport.findMany({
    where: { coachProfileId },
    include: { sport: { select: { id: true, name: true, slug: true } } },
  });

  return rows.map((row) => ({ id: row.sport.id, name: row.sport.name, slug: row.sport.slug }));
}

export async function listMyAvailability(userId: string): Promise<AvailabilitySlot[]> {
  const coachProfileId = await findCoachProfileId(userId);
  if (!coachProfileId) {
    return [];
  }

  const slots = await prisma.availability.findMany({
    where: { coachProfileId },
    orderBy: { startAt: 'asc' },
  });

  return slots.map((slot) => ({
    id: slot.id,
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    isAvailable: slot.isAvailable,
  }));
}

/** Adds an availability window. Overlapping windows are rejected to keep the model unambiguous. */
export async function createMyAvailability(
  userId: string,
  input: CreateAvailabilityBody,
): Promise<AvailabilitySlot[]> {
  const coachProfileId = await requireCoachProfileId(userId);
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  if (endAt.getTime() <= startAt.getTime()) {
    throw ApiError.badRequest('startAt must be before endAt');
  }

  const overlapping = await prisma.availability.findFirst({
    where: { coachProfileId, startAt: { lt: endAt }, endAt: { gt: startAt } },
    select: { id: true },
  });

  if (overlapping) {
    throw ApiError.conflict('This window overlaps an existing availability entry');
  }

  await prisma.availability.create({
    data: { coachProfileId, startAt, endAt, isAvailable: input.isAvailable },
  });

  return listMyAvailability(userId);
}

export async function deleteMyAvailability(userId: string, availabilityId: string): Promise<AvailabilitySlot[]> {
  const coachProfileId = await requireCoachProfileId(userId);

  const existing = await prisma.availability.findFirst({
    where: { id: availabilityId, coachProfileId },
    select: { id: true },
  });

  if (!existing) {
    throw ApiError.notFound('Availability entry not found');
  }

  await prisma.availability.delete({ where: { id: availabilityId } });
  return listMyAvailability(userId);
}

/**
 * Public coach detail.
 *
 * A profile is only visible when it is published *and* its owner's verification
 * application is APPROVED. An unverified coach is indistinguishable from an unknown id
 * (404), so verification cannot be bypassed by calling the API directly.
 */
export async function getCoachById(coachProfileId: string): Promise<CoachDetailResponse> {
  const coach = await prisma.coachProfile.findFirst({
    where: {
      id: coachProfileId,
      isPublished: true,
      verification: { is: { status: VerificationStatus.APPROVED } },
    },
    include: {
      ...COACH_PROFILE_INCLUDE,
      // Only future, open windows are useful to a client.
      availability: { where: { isAvailable: true, endAt: { gt: new Date() } }, orderBy: { startAt: 'asc' }, take: 50 },
      _count: { select: { bookings: { where: { status: BookingStatus.COMPLETED } } } },
    },
  });

  if (!coach) {
    throw ApiError.notFound('Coach profile not found');
  }

  const metrics = await getRatingSummary(coach.id);
  return toCoachDetail(coach, { ...metrics, distanceKm: undefined });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM_FOR_SQL = 6371;

/**
 * Single source of truth for the discovery gate, shared by search and suggestions.
 * A coach profile is only discoverable with an APPROVED verification application.
 */
export const APPROVED_VERIFICATION_CONDITION = Prisma.sql`EXISTS (
  SELECT 1 FROM coach_verifications cv
  WHERE cv.coach_profile_id = cp.id AND cv.status = 'APPROVED'
)`;

interface RawCoachSearchRow {
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
}

export interface CoachSearchResult {
  coaches: CoachSummaryResponse[];
  total: number;
}

/**
 * Search published coach profiles.
 *
 * All filters are combined with AND. Sorting happens in SQL so pagination is stable.
 * The statements are fully parameterized (`Prisma.sql` tagged templates) - no user
 * input is ever concatenated into SQL text; the only raw fragment is the ORDER BY
 * clause, which is built from a validated enum.
 */
export async function searchCoaches(
  query: SearchCoachesQuery,
  options: { excludeUserIds?: string[] } = {},
): Promise<CoachSearchResult> {
  const hasCoordinates = query.latitude !== undefined && query.longitude !== undefined;
  const excludeUserIds = options.excludeUserIds ?? [];

  const conditions: Prisma.Sql[] = [
    Prisma.sql`cp.is_published = true`,
    // Verification gate: only APPROVED coaches are discoverable. Enforced in SQL (not only
    // in the service layer) so every filter/sort/pagination combination inherits it.
    APPROVED_VERIFICATION_CONDITION,
  ];

  // Signed-in callers never see coaches they blocked (or who blocked them).
  if (excludeUserIds.length > 0) {
    conditions.push(Prisma.sql`cp.user_id NOT IN (${Prisma.join(excludeUserIds)})`);
  }

  if (query.sport) {
    // Accepts a slug ("boxing") or a name ("Boxing").
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM coach_sports cs
      JOIN sports s ON s.id = cs.sport_id
      WHERE cs.coach_profile_id = cp.id
        AND (s.slug = ${query.sport.trim().toLowerCase()} OR s.name ILIKE ${query.sport.trim()})
    )`);
  }

  if (query.city) {
    conditions.push(Prisma.sql`cp.city ILIKE ${query.city.trim()}`);
  }

  if (query.country) {
    // The coach's country lives on their user profile (added in Phase 1).
    conditions.push(Prisma.sql`u.country ILIKE ${query.country.trim()}`);
  }

  if (query.level) {
    conditions.push(Prisma.sql`cp.experience_level = ${query.level}::"ExperienceLevel"`);
  }

  if (query.neighborhood) {
    conditions.push(Prisma.sql`cp.neighborhood ILIKE ${query.neighborhood.trim()}`);
  }

  if (query.minPrice !== undefined) {
    conditions.push(Prisma.sql`cp.hourly_price >= ${query.minPrice}`);
  }

  if (query.maxPrice !== undefined) {
    conditions.push(Prisma.sql`cp.hourly_price <= ${query.maxPrice}`);
  }

  if (query.minRating !== undefined) {
    conditions.push(Prisma.sql`COALESCE(agg.avg_rating, 0) >= ${query.minRating}`);
  }

  const distanceExpression = hasCoordinates
    ? Prisma.sql`(2 * ${EARTH_RADIUS_KM_FOR_SQL} * asin(sqrt(
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
      ${distanceExpression} AS distance_km
    FROM coach_profiles cp
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN (
      SELECT
        r.coach_profile_id AS coach_profile_id,
        AVG(r.rating)::float8 AS avg_rating,
        COUNT(*)::int AS review_count
      FROM reviews r
      GROUP BY r.coach_profile_id
    ) AS agg ON agg.coach_profile_id = cp.id
    WHERE ${Prisma.join(conditions, ' AND ')}
  `;

  // The radius filter applies to the computed distance, which is why it is applied
  // in an outer query rather than in the WHERE clause above.
  const outerFilter =
    query.radiusKm !== undefined ? Prisma.sql`WHERE c.distance_km <= ${query.radiusKm}` : Prisma.empty;

  const orderBy = buildOrderBy(query.sort);
  const offset = (query.page - 1) * query.limit;

  const [countRows, rows] = await Promise.all([
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM (${baseQuery}) AS c
      ${outerFilter}
    `),
    prisma.$queryRaw<RawCoachSearchRow[]>(Prisma.sql`
      SELECT c.* FROM (${baseQuery}) AS c
      ${outerFilter}
      ORDER BY ${orderBy}
      LIMIT ${query.limit} OFFSET ${offset}
    `),
  ]);

  const total = countRows[0]?.total ?? 0;
  const coachIds = rows.map((row) => row.coach_profile_id);

  const sportRows =
    coachIds.length === 0
      ? []
      : await prisma.coachSport.findMany({
          where: { coachProfileId: { in: coachIds } },
          include: { sport: { select: { id: true, name: true, slug: true } } },
        });

  const sportsByCoachId = new Map<string, { sport: SportSummary }[]>();
  for (const row of sportRows) {
    const bucket = sportsByCoachId.get(row.coachProfileId) ?? [];
    bucket.push({ sport: { id: row.sport.id, name: row.sport.name, slug: row.sport.slug } });
    sportsByCoachId.set(row.coachProfileId, bucket);
  }

  const coaches = rows.map((row) =>
    toCoachSummary(toProfileLike(row, sportsByCoachId.get(row.coach_profile_id) ?? []), {
      averageRating: row.review_count > 0 ? roundTo(row.avg_rating, 2) : null,
      reviewCount: row.review_count,
      distanceKm: row.distance_km === null ? null : roundDistanceKm(row.distance_km),
    }),
  );

  return { coaches, total };
}

function toProfileLike(row: RawCoachSearchRow, sports: { sport: SportSummary }[]): CoachProfileLike {
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

function buildOrderBy(sort: CoachSort): Prisma.Sql {
  switch (sort) {
    case 'distance_asc':
      return Prisma.raw('c.distance_km ASC NULLS LAST, c.coach_profile_id ASC');
    case 'distance_desc':
      return Prisma.raw('c.distance_km DESC NULLS LAST, c.coach_profile_id ASC');
    case 'price_asc':
      return Prisma.raw('c.hourly_price ASC, c.coach_profile_id ASC');
    case 'price_desc':
      return Prisma.raw('c.hourly_price DESC, c.coach_profile_id ASC');
    case 'rating_desc':
      return Prisma.raw('c.avg_rating DESC, c.review_count DESC, c.coach_profile_id ASC');
    case 'rating_asc':
      return Prisma.raw('c.avg_rating ASC, c.review_count ASC, c.coach_profile_id ASC');
    case 'oldest':
      return Prisma.raw('c.created_at ASC, c.coach_profile_id ASC');
    case 'newest':
    default:
      return Prisma.raw('c.created_at DESC, c.coach_profile_id ASC');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export async function requireCoachProfileId(userId: string): Promise<string> {
  const coachProfileId = await findCoachProfileId(userId);
  if (!coachProfileId) {
    throw ApiError.notFound('You do not have a coach profile yet. Create one with POST /api/v1/coaches/me/profile');
  }
  return coachProfileId;
}

async function findCoachProfileId(userId: string): Promise<string | null> {
  const profile = await prisma.coachProfile.findUnique({ where: { userId }, select: { id: true } });
  return profile?.id ?? null;
}

/**
 * A profile may only be published when it has coordinates (distance search depends
 * on them) and at least one sport (otherwise it can never be found).
 */
function assertPublishable(input: {
  isPublished: boolean;
  latitude?: number | null;
  longitude?: number | null;
  sportCount: number;
}): void {
  if (!input.isPublished) {
    return;
  }

  const problems: string[] = [];
  if (input.latitude === undefined || input.latitude === null || input.longitude === undefined || input.longitude === null) {
    problems.push('latitude and longitude are required to publish a profile');
  }
  if (input.sportCount < 1) {
    problems.push('at least one sport is required to publish a profile');
  }

  if (problems.length > 0) {
    throw ApiError.badRequest(`Cannot publish this coach profile: ${problems.join('; ')}`, { problems });
  }
}
