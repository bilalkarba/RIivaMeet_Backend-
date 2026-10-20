import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Response } from 'supertest';

import { createApp } from '../../src/app.js';
import { prisma } from './database.js';

/**
 * Test client + domain helpers.
 *
 * The app is created once per worker (supertest drives it in-process, so no port is
 * opened) and every helper goes through the public HTTP API wherever possible -
 * tests should exercise the same code paths clients use.
 */

export const app = createApp();

export function api(): request.Agent {
  return request(app);
}

export const TEST_PASSWORD = 'Passw0rd123';

let counter = 0;

export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  role: 'CLIENT' | 'COACH' | 'ADMIN';
}

export interface RegisterUserOptions {
  role?: 'CLIENT' | 'COACH';
  email?: string;
  password?: string;
  name?: string;
  phone?: string;
}

/** Register a user through the public API and return the issued access token. */
export async function registerUser(options: RegisterUserOptions = {}): Promise<TestUser> {
  const email = options.email ?? uniqueEmail(options.role === 'COACH' ? 'coach' : 'client');
  const role = options.role ?? 'CLIENT';

  const response = await api()
    .post('/api/v1/auth/register')
    .send({
      email,
      password: options.password ?? TEST_PASSWORD,
      name: options.name ?? (role === 'COACH' ? 'Test Coach' : 'Test Client'),
      role,
      ...(options.phone ? { phone: options.phone } : {}),
    });

  if (response.status !== 201) {
    throw new Error(`registerUser failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  return {
    id: response.body.data.user.id,
    email,
    token: response.body.data.accessToken,
    role,
  };
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Create an ADMIN account out of band (there is deliberately no public endpoint for it)
 * and sign in through the real login endpoint to obtain a token.
 */
export async function registerAdmin(options: { email?: string } = {}): Promise<TestUser> {
  const email = options.email ?? uniqueEmail('admin');
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);

  await prisma.user.create({
    data: { email, passwordHash, name: 'Test Admin', role: 'ADMIN' },
  });

  const login = await api().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`admin login failed (${login.status}): ${JSON.stringify(login.body)}`);
  }

  return { id: login.body.data.user.id, email, token: login.body.data.accessToken, role: 'ADMIN' };
}

/**
 * An ADMIN row used by test setup (verification approval). Public registration refuses the
 * ADMIN role, so it is created directly; the password hash is never used to sign in.
 */
export async function ensureVerificationAdmin(): Promise<string> {
  const admin = await prisma.user.upsert({
    where: { email: 'verification-admin@coachini.test' },
    update: {},
    create: {
      email: 'verification-admin@coachini.test',
      passwordHash: 'test-setup-only-not-a-real-hash',
      name: 'Verification Admin',
      role: 'ADMIN',
    },
    select: { id: true },
  });
  return admin.id;
}

/**
 * Mark a coach as verified.
 *
 * Discovery and booking now require an APPROVED verification application, so any test
 * that needs a *visible* coach approves one here just like an administrator would.
 * `createCoach` calls this by default; pass `approved: false` to test the gate itself.
 */
export async function approveVerification(
  coachProfileId: string,
  options: { adminId?: string; note?: string } = {},
): Promise<void> {
  const reviewedById = options.adminId ?? (await ensureVerificationAdmin());
  const note = options.note ?? 'Approved during test setup';

  await prisma.coachVerification.upsert({
    where: { coachProfileId },
    update: { status: 'APPROVED', reviewedById, reviewedAt: new Date(), reviewNote: note },
    create: {
      coachProfileId,
      status: 'APPROVED',
      submittedAt: new Date(),
      lastSubmittedAt: new Date(),
      reviewedById,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  });
}

export interface CreateCoachOptions {
  city?: string;
  neighborhood?: string;
  latitude?: number;
  longitude?: number;
  hourlyPrice?: number;
  sports?: string[];
  published?: boolean;
  /** Whether the coach is verified. Defaults to the `published` value. */
  approved?: boolean;
  bio?: string;
  certifications?: string[];
  experienceLevel?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'PROFESSIONAL';
  /** Number of days of availability windows to create (09:00-18:00 UTC each day). */
  availabilityDays?: number;
  email?: string;
  name?: string;
}

export interface TestCoach extends TestUser {
  coachProfileId: string;
  hourlyPrice: number;
}

/**
 * Create a coach user with a full profile: profile record, offered sports,
 * availability windows, and (by default) published state.
 */
export async function createCoach(options: CreateCoachOptions = {}): Promise<TestCoach> {
  const hourlyPrice = options.hourlyPrice ?? 45;
  const latitude = options.latitude ?? 52.520008;
  const longitude = options.longitude ?? 13.404954;
  const published = options.published ?? true;

  const user = await registerUser({ role: 'COACH', email: options.email, name: options.name });

  const profileResponse = await api()
    .post('/api/v1/coaches/me/profile')
    .set('Authorization', bearer(user.token))
    .send({
      bio:
        options.bio ??
        'Experienced coach with a decade of practice, focused on technique, conditioning and injury prevention.',
      ...(options.certifications ? { certifications: options.certifications } : {}),
      hourlyPrice,
      experienceLevel: options.experienceLevel ?? 'ADVANCED',
      city: options.city ?? 'Berlin',
      neighborhood: options.neighborhood ?? 'Mitte',
      latitude,
      longitude,
    });

  if (profileResponse.status !== 201) {
    throw new Error(`coach profile creation failed (${profileResponse.status}): ${JSON.stringify(profileResponse.body)}`);
  }

  const coachProfileId: string = profileResponse.body.data.id;

  const sportsResponse = await api()
    .put('/api/v1/coaches/me/sports')
    .set('Authorization', bearer(user.token))
    .send({ sportSlugs: options.sports ?? ['fitness'] });

  if (sportsResponse.status !== 200) {
    throw new Error(`coach sports setup failed (${sportsResponse.status}): ${JSON.stringify(sportsResponse.body)}`);
  }

  const days = options.availabilityDays ?? 7;
  for (let day = 1; day <= days; day += 1) {
    const window = availabilityWindow(day, 9, 9);
    const availabilityResponse = await api()
      .post('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(user.token))
      .send(window);

    if (availabilityResponse.status !== 201) {
      throw new Error(`availability setup failed (${availabilityResponse.status}): ${JSON.stringify(availabilityResponse.body)}`);
    }
  }

  if (published) {
    const publishResponse = await api()
      .patch('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(user.token))
      .send({ isPublished: true });

    if (publishResponse.status !== 200) {
      throw new Error(`publishing failed (${publishResponse.status}): ${JSON.stringify(publishResponse.body)}`);
    }
  }

  // A published coach is verified by default: discovery and bookings require APPROVED.
  if (options.approved ?? published) {
    await approveVerification(coachProfileId);
  }

  return { ...user, coachProfileId, hourlyPrice };
}

/**
 * Time window helper. `dayOffset` is days from today, hours are UTC.
 * Booking tests use `bookingWindow(day, 10, 1)` -> 10:00-11:00 UTC on that day,
 * which sits inside the 09:00-18:00 availability window created by `createCoach`.
 */
export function availabilityWindow(dayOffset: number, startHourUtc: number, durationHours: number): {
  startAt: string;
  endAt: string;
} {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);

  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() + dayOffset);
  start.setUTCHours(startHourUtc, 0, 0, 0);

  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);

  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

export function bookingWindow(dayOffset: number, startHourUtc: number, durationHours = 1): {
  startAt: string;
  endAt: string;
} {
  return availabilityWindow(dayOffset, startHourUtc, durationHours);
}

/** Request a booking as a client and return the raw response. */
export async function requestBooking(
  clientToken: string,
  coachProfileId: string,
  window: { startAt: string; endAt: string },
): Promise<Response> {
  return api()
    .post('/api/v1/bookings')
    .set('Authorization', bearer(clientToken))
    .send({ coachProfileId, ...window });
}

/** Request -> accept -> complete, returning the completed booking response. */
export async function completeBooking(
  clientToken: string,
  coachToken: string,
  coachProfileId: string,
  window: { startAt: string; endAt: string },
): Promise<Response> {
  const created = await requestBooking(clientToken, coachProfileId, window);
  if (created.status !== 201) {
    throw new Error(`booking creation failed (${created.status}): ${JSON.stringify(created.body)}`);
  }

  const bookingId: string = created.body.data.id;

  const accepted = await api()
    .patch(`/api/v1/bookings/${bookingId}/accept`)
    .set('Authorization', bearer(coachToken));
  if (accepted.status !== 200) {
    throw new Error(`accept failed (${accepted.status}): ${JSON.stringify(accepted.body)}`);
  }

  return api().patch(`/api/v1/bookings/${bookingId}/complete`).set('Authorization', bearer(coachToken));
}

/** Create a review through the public API. */
export async function reviewBooking(
  clientToken: string,
  bookingId: string,
  body: { rating: number; comment?: string },
): Promise<Response> {
  return api().post(`/api/v1/bookings/${bookingId}/review`).set('Authorization', bearer(clientToken)).send(body);
}
