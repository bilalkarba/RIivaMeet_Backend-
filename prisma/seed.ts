import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { BookingStatus, ExperienceLevel, Role } from '../src/generated/prisma/enums.js';

/**
 * Database seed.
 *
 * Always creates the required sport catalogue:
 *   Fitness, Boxing, Swimming, Football, Tennis
 *
 * With SEED_DEMO_DATA=true it additionally creates an admin plus demo coaches and a
 * demo client so the API can be explored end to end. The demo password defaults to
 * `Passw0rd123` and can be overridden with SEED_DEMO_PASSWORD. Demo data is never
 * created by default - deployments only get the sport catalogue.
 */

const SPORTS: { name: string; slug: string }[] = [
  { name: 'Fitness', slug: 'fitness' },
  { name: 'Boxing', slug: 'boxing' },
  { name: 'Swimming', slug: 'swimming' },
  { name: 'Football', slug: 'football' },
  { name: 'Tennis', slug: 'tennis' },
];

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the seed script');
  }

  const adapter = new PrismaPg({ connectionString, max: 2 });
  return new PrismaClient({ adapter });
}

/**
 * Idempotent: safe to run repeatedly (used by tests after truncating the database).
 * Accepts an existing client so callers can reuse their connection.
 */
export async function seedSports(client: PrismaClient): Promise<Map<string, string>> {
  const sportIdsBySlug = new Map<string, string>();

  for (const sport of SPORTS) {
    const record = await client.sport.upsert({
      where: { slug: sport.slug },
      update: { name: sport.name },
      create: { name: sport.name, slug: sport.slug },
    });
    sportIdsBySlug.set(record.slug, record.id);
  }

  return sportIdsBySlug;
}

/** Optional demo dataset used for manual testing. */
export async function seedDemoData(client: PrismaClient, sportIdsBySlug: Map<string, string>): Promise<void> {
  // Imported lazily so the seed can run without bcrypt being bundled in edge contexts.
  const bcrypt = (await import('bcrypt')).default;
  const password = process.env.SEED_DEMO_PASSWORD ?? 'Passw0rd123';
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await client.user.upsert({
    where: { email: 'admin@coachini.test' },
    update: {},
    create: {
      email: 'admin@coachini.test',
      passwordHash,
      name: 'Platform Admin',
      role: Role.ADMIN,
    },
  });

  const clientUser = await client.user.upsert({
    where: { email: 'client@coachini.test' },
    update: {},
    create: {
      email: 'client@coachini.test',
      passwordHash,
      name: 'Demo Client',
      role: Role.CLIENT,
      phone: '+4915100000001',
    },
  });

  const coaches: {
    email: string;
    name: string;
    bio: string;
    certifications: string[];
    hourlyPrice: number;
    experienceLevel: ExperienceLevel;
    city: string;
    neighborhood: string;
    latitude: number;
    longitude: number;
    sportSlugs: string[];
  }[] = [
    {
      email: 'anna.coach@coachini.test',
      name: 'Anna Schmidt',
      bio: 'Certified boxing and fitness coach with 8 years of experience training beginners and competitive athletes.',
      certifications: ['UEFA B Licence', 'First Aid Certificate'],
      hourlyPrice: 45,
      experienceLevel: ExperienceLevel.PROFESSIONAL,
      city: 'Berlin',
      neighborhood: 'Mitte',
      latitude: 52.520008,
      longitude: 13.404954,
      sportSlugs: ['boxing', 'fitness'],
    },
    {
      email: 'omar.coach@coachini.test',
      name: 'Omar Haddad',
      bio: 'Swimming coach focused on technique, water confidence and endurance for adults at every level.',
      certifications: ['Lifeguard Certificate', 'Swim Teacher Level 2'],
      hourlyPrice: 38.5,
      experienceLevel: ExperienceLevel.ADVANCED,
      city: 'Hamburg',
      neighborhood: 'Altona',
      latitude: 53.551086,
      longitude: 9.993682,
      sportSlugs: ['swimming'],
    },
  ];

  let createdCoachProfileId: string | null = null;

  for (const coach of coaches) {
    const user = await client.user.upsert({
      where: { email: coach.email },
      update: {},
      create: { email: coach.email, passwordHash, name: coach.name, role: Role.COACH },
    });

    const profile = await client.coachProfile.upsert({
      where: { userId: user.id },
      update: { isPublished: true },
      create: {
        userId: user.id,
        bio: coach.bio,
        certifications: coach.certifications,
        hourlyPrice: coach.hourlyPrice,
        experienceLevel: coach.experienceLevel,
        city: coach.city,
        neighborhood: coach.neighborhood,
        latitude: coach.latitude,
        longitude: coach.longitude,
        isPublished: true,
      },
    });

    createdCoachProfileId ??= profile.id;

    for (const slug of coach.sportSlugs) {
      const sportId = sportIdsBySlug.get(slug);
      if (!sportId) {
        continue;
      }
      await client.coachSport.upsert({
        where: { coachProfileId_sportId: { coachProfileId: profile.id, sportId } },
        update: {},
        create: { coachProfileId: profile.id, sportId },
      });
    }

    // Open availability windows for the next 14 days (09:00-12:00 and 15:00-18:00 UTC).
    const existingSlots = await client.availability.count({ where: { coachProfileId: profile.id } });
    if (existingSlots === 0) {
      const base = new Date();
      base.setUTCHours(0, 0, 0, 0);

      for (let day = 1; day <= 14; day += 1) {
        for (const [startHour, endHour] of [
          [9, 12],
          [15, 18],
        ] as const) {
          const startAt = new Date(base);
          startAt.setUTCDate(base.getUTCDate() + day);
          startAt.setUTCHours(startHour, 0, 0, 0);

          const endAt = new Date(base);
          endAt.setUTCDate(base.getUTCDate() + day);
          endAt.setUTCHours(endHour, 0, 0, 0);

          await client.availability.create({
            data: { coachProfileId: profile.id, startAt, endAt, isAvailable: true },
          });
        }
      }
    }
  }

  // A completed booking + review so rating aggregates are visible out of the box.
  if (createdCoachProfileId) {
    const existingBooking = await client.booking.findFirst({
      where: { clientId: clientUser.id, coachProfileId: createdCoachProfileId },
      select: { id: true },
    });

    if (!existingBooking) {
      const coachProfile = await client.coachProfile.findUniqueOrThrow({
        where: { id: createdCoachProfileId },
        select: { hourlyPrice: true },
      });

      const startAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      startAt.setUTCHours(9, 0, 0, 0);
      const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

      const booking = await client.booking.create({
        data: {
          clientId: clientUser.id,
          coachProfileId: createdCoachProfileId,
          startAt,
          endAt,
          priceAtBooking: coachProfile.hourlyPrice,
          status: BookingStatus.COMPLETED,
        },
      });

      await client.review.create({
        data: {
          bookingId: booking.id,
          clientId: clientUser.id,
          coachProfileId: createdCoachProfileId,
          rating: 5,
          comment: 'Excellent session, clear explanations and a great training plan.',
        },
      });
    }
  }

  console.log(`Seeded demo data (admin: ${admin.email}, client: ${clientUser.email}, password: ${password})`);
}

export async function runSeed(client: PrismaClient, options?: { withDemoData?: boolean }): Promise<void> {
  const sportIdsBySlug = await seedSports(client);
  console.log(`Seeded ${sportIdsBySlug.size} sports: ${[...sportIdsBySlug.keys()].join(', ')}`);

  const withDemoData = options?.withDemoData ?? process.env.SEED_DEMO_DATA === 'true';
  if (withDemoData) {
    await seedDemoData(client, sportIdsBySlug);
  } else {
    console.log('Skipped demo data (set SEED_DEMO_DATA=true to include demo users, coaches and bookings).');
  }
}

/** True when this module is executed directly (`npm run seed`) rather than imported by tests. */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === entry || entry.endsWith('seed.ts') || entry.endsWith('seed.js');
}

if (isDirectExecution()) {
  const prisma = createPrismaClient();
  runSeed(prisma)
    .catch((error: unknown) => {
      console.error('Seed failed:', error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
