import { prisma } from '../config/prisma.js';
import { VerificationStatus } from '../generated/prisma/enums.js';
import { ApiError } from '../utils/errors.js';
import type { SportWithCoachCount } from '../utils/presenters.js';

/**
 * Sports catalogue.
 *
 * The seed script inserts the required sports (Fitness, Boxing, Swimming, Football,
 * Tennis). `coachCount` counts only coach profiles that are both published *and* verified,
 * so the value matches what a client would actually find when searching.
 */
export async function listSports(): Promise<SportWithCoachCount[]> {
  const [sports, counts] = await Promise.all([
    prisma.sport.findMany({ orderBy: { name: 'asc' } }),
    prisma.coachSport.groupBy({
      by: ['sportId'],
      where: {
        coachProfile: {
          isPublished: true,
          verification: { is: { status: VerificationStatus.APPROVED } },
        },
      },
      _count: { _all: true },
    }),
  ]);

  const countBySportId = new Map(counts.map((entry) => [entry.sportId, entry._count._all]));

  return sports.map((sport) => ({
    id: sport.id,
    name: sport.name,
    slug: sport.slug,
    coachCount: countBySportId.get(sport.id) ?? 0,
  }));
}

/** Resolve sport slugs (or ids) to existing sport records, rejecting unknown values. */
export async function resolveSportsByIdentifiers(input: {
  sportIds?: string[];
  sportSlugs?: string[];
}): Promise<{ id: string; name: string; slug: string }[]> {
  const requestedSlugs = (input.sportSlugs ?? []).map((slug) => slug.trim().toLowerCase());
  const where = input.sportIds ? { id: { in: input.sportIds } } : { slug: { in: requestedSlugs } };

  const sports = await prisma.sport.findMany({ where, select: { id: true, name: true, slug: true } });

  const requested = input.sportIds ?? requestedSlugs;
  const found = new Set(input.sportIds ? sports.map((sport) => sport.id) : sports.map((sport) => sport.slug));
  const missing = requested.filter((value) => !found.has(value));

  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown sport(s): ${missing.join(', ')}`, {
      unknownSports: missing,
      hint: 'Call GET /api/v1/sports for the list of supported sports.',
    });
  }

  return sports;
}
