import { prisma } from '../config/prisma.js';
import type {
  AddProfileSportBody,
  ReplaceProfileSportsBody,
  UpdateProfileBody,
} from '../schemas/profile.schema.js';
import { ApiError } from '../utils/errors.js';
import {
  toPublicProfile,
  toSelfProfile,
  type ProfileSportEntry,
  type PublicProfileResponse,
  type SelfProfileResponse,
} from '../utils/presenters.js';
import { resolveSportsByIdentifiers } from './sport.service.js';

/**
 * Self-service profile service (Phase 1).
 *
 * A `User` carries the account and the athlete-facing profile fields; coaches keep
 * their professional details on `CoachProfile`. Read models are built by the presenters
 * so that email/phone never leak through the public profile endpoint.
 */

const PROFILE_INCLUDE = {
  sports: { include: { sport: { select: { id: true, name: true, slug: true } } } },
  coachProfile: { select: { id: true } },
} as const;

export async function getSelfProfile(userId: string): Promise<SelfProfileResponse> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: PROFILE_INCLUDE });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  return toSelfProfile(user, user.sports, { coachProfileId: user.coachProfile?.id ?? null });
}

export async function updateSelfProfile(userId: string, input: UpdateProfileBody): Promise<SelfProfileResponse> {
  const data = {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
    ...(input.bio === undefined ? {} : { bio: input.bio }),
    ...(input.city === undefined ? {} : { city: input.city }),
    ...(input.country === undefined ? {} : { country: input.country }),
    ...(input.level === undefined ? {} : { level: input.level }),
  };

  try {
    await prisma.user.update({ where: { id: userId }, data });
  } catch {
    throw ApiError.notFound('User not found');
  }

  return getSelfProfile(userId);
}

/** Privacy-safe public profile (no email, phone, or moderation data). */
export async function getPublicProfile(userId: string): Promise<PublicProfileResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      role: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      city: true,
      country: true,
      level: true,
      createdAt: true,
      updatedAt: true,
      sports: { include: { sport: { select: { id: true, name: true, slug: true } } } },
      coachProfile: { select: { id: true } },
    },
  });

  if (!user) {
    throw ApiError.notFound('Profile not found');
  }

  return toPublicProfile(user, user.sports, { coachProfileId: user.coachProfile?.id ?? null });
}

export async function getMySports(userId: string): Promise<ProfileSportEntry[]> {
  const rows = await prisma.userSport.findMany({
    where: { userId },
    include: { sport: { select: { id: true, name: true, slug: true } } },
  });

  return rows
    .map((row) => ({ id: row.sport.id, name: row.sport.name, slug: row.sport.slug, level: row.level }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Replace the athlete's discipline list (idempotent). */
export async function replaceMySports(
  userId: string,
  input: ReplaceProfileSportsBody,
): Promise<ProfileSportEntry[]> {
  const sports = await resolveSportsByIdentifiers(input);

  await prisma.$transaction(async (tx) => {
    await tx.userSport.deleteMany({
      where: { userId, sportId: { notIn: sports.map((sport) => sport.id) } },
    });
    if (input.level !== undefined) {
      await tx.userSport.updateMany({ where: { userId }, data: { level: input.level } });
    }
    await tx.userSport.createMany({
      data: sports.map((sport) => ({ userId, sportId: sport.id, level: input.level ?? null })),
      skipDuplicates: true,
    });
  });

  return getMySports(userId);
}

export async function addMySport(userId: string, input: AddProfileSportBody): Promise<ProfileSportEntry[]> {
  const [sport] = await resolveSportsByIdentifiers({ sportIds: [input.sportId] });
  if (!sport) {
    throw ApiError.badRequest('Unknown sport');
  }

  await prisma.userSport.upsert({
    where: { userId_sportId: { userId, sportId: sport.id } },
    create: { userId, sportId: sport.id, level: input.level ?? null },
    update: { level: input.level ?? null },
  });

  return getMySports(userId);
}

export async function removeMySport(userId: string, sportId: string): Promise<ProfileSportEntry[]> {
  const existing = await prisma.userSport.findUnique({
    where: { userId_sportId: { userId, sportId } },
    select: { sportId: true },
  });

  if (!existing) {
    throw ApiError.notFound('This discipline is not part of your profile');
  }

  await prisma.userSport.delete({ where: { userId_sportId: { userId, sportId } } });
  return getMySports(userId);
}
