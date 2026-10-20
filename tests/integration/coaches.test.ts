import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, completeBooking, createCoach, registerUser, uniqueEmail } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';
import { haversineDistanceKm } from '../../src/utils/geo.js';

/**
 * Coach search + profile management.
 *
 * Reference coordinates:
 *   Berlin Mitte  52.520008, 13.404954
 *   Hamburg       53.551086, 9.993682  (~255 km from Berlin)
 */

const BERLIN = { latitude: 52.520008, longitude: 13.404954 };
const HAMBURG = { latitude: 53.551086, longitude: 9.993682 };

describe('Coach search', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('lists only published coach profiles', async () => {
    const published = await createCoach({ published: true });
    const draft = await createCoach({ published: false, email: uniqueEmail('draft') });

    const response = await api().get('/api/v1/coaches');

    expect(response.status).toBe(200);
    const ids = response.body.data.map((coach: { id: string }) => coach.id);
    expect(ids).toContain(published.coachProfileId);
    expect(ids).not.toContain(draft.coachProfileId);
  });

  it('returns the coach card shape with derived rating fields', async () => {
    await createCoach({ sports: ['boxing', 'fitness'] });

    const response = await api().get('/api/v1/coaches');
    const coach = response.body.data[0];

    expect(coach).toMatchObject({
      name: 'Test Coach',
      city: 'Berlin',
      neighborhood: 'Mitte',
      experienceLevel: 'ADVANCED',
      hourlyPrice: '45.00',
      isPublished: true,
      averageRating: null,
      reviewCount: 0,
    });
    expect(coach.sports.map((sport: { slug: string }) => sport.slug).sort()).toEqual(['boxing', 'fitness']);
    expect(new Date(coach.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('filters by sport slug and by sport name', async () => {
    const boxer = await createCoach({ sports: ['boxing'] });
    const swimmer = await createCoach({ sports: ['swimming'], email: uniqueEmail('swim') });

    const bySlug = await api().get('/api/v1/coaches').query({ sport: 'boxing' });
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.map((coach: { id: string }) => coach.id)).toEqual([boxer.coachProfileId]);

    const byName = await api().get('/api/v1/coaches').query({ sport: 'Swimming' });
    expect(byName.body.data.map((coach: { id: string }) => coach.id)).toEqual([swimmer.coachProfileId]);

    const unknownSport = await api().get('/api/v1/coaches').query({ sport: 'curling' });
    expect(unknownSport.status).toBe(200);
    expect(unknownSport.body.data).toEqual([]);
  });

  it('filters by city and neighborhood case-insensitively', async () => {
    const berlinCoach = await createCoach({ city: 'Berlin', neighborhood: 'Mitte' });
    const hamburgCoach = await createCoach({
      city: 'Hamburg',
      neighborhood: 'Altona',
      latitude: HAMBURG.latitude,
      longitude: HAMBURG.longitude,
      email: uniqueEmail('hamburg'),
    });

    const byCity = await api().get('/api/v1/coaches').query({ city: 'berlin' });
    expect(byCity.body.data.map((coach: { id: string }) => coach.id)).toEqual([berlinCoach.coachProfileId]);

    const byNeighborhood = await api().get('/api/v1/coaches').query({ neighborhood: 'ALTONA' });
    expect(byNeighborhood.body.data.map((coach: { id: string }) => coach.id)).toEqual([hamburgCoach.coachProfileId]);

    const combined = await api().get('/api/v1/coaches').query({ city: 'Hamburg', neighborhood: 'Mitte' });
    expect(combined.body.data).toEqual([]);
  });

  it('filters by minimum and maximum hourly price', async () => {
    const cheap = await createCoach({ hourlyPrice: 20, email: uniqueEmail('cheap') });
    const mid = await createCoach({ hourlyPrice: 45, email: uniqueEmail('mid') });
    const expensive = await createCoach({ hourlyPrice: 90, email: uniqueEmail('expensive') });

    const min = await api().get('/api/v1/coaches').query({ minPrice: 40 });
    expect(min.body.data.map((coach: { id: string }) => coach.id).sort()).toEqual(
      [mid.coachProfileId, expensive.coachProfileId].sort(),
    );

    const max = await api().get('/api/v1/coaches').query({ maxPrice: 45 });
    expect(max.body.data.map((coach: { id: string }) => coach.id).sort()).toEqual(
      [cheap.coachProfileId, mid.coachProfileId].sort(),
    );

    const range = await api().get('/api/v1/coaches').query({ minPrice: 30, maxPrice: 50 });
    expect(range.body.data.map((coach: { id: string }) => coach.id)).toEqual([mid.coachProfileId]);
  });

  it('filters by minimum rating using review aggregates', async () => {
    const strong = await createCoach({ email: uniqueEmail('strong') });
    const weak = await createCoach({ email: uniqueEmail('weak') });

    const client = await registerUser();

    // strong: 5 stars, weak: 2 stars (both from completed bookings).
    const strongBooking = await completeBooking(
      client.token,
      strong.token,
      strong.coachProfileId,
      dayWindow(1, 10),
    );
    await api()
      .post(`/api/v1/bookings/${strongBooking.body.data.id}/review`)
      .set('Authorization', bearer(client.token))
      .send({ rating: 5, comment: 'Outstanding coaching session.' });

    const weakBooking = await completeBooking(client.token, weak.token, weak.coachProfileId, dayWindow(1, 10));
    await api()
      .post(`/api/v1/bookings/${weakBooking.body.data.id}/review`)
      .set('Authorization', bearer(client.token))
      .send({ rating: 2, comment: 'Not what I was hoping for.' });

    const response = await api().get('/api/v1/coaches').query({ minRating: 4 });

    expect(response.status).toBe(200);
    expect(response.body.data.map((coach: { id: string }) => coach.id)).toEqual([strong.coachProfileId]);
    expect(response.body.data[0].averageRating).toBe(5);
    expect(response.body.data[0].reviewCount).toBe(1);
  });

  it('combines sport, city and price filters', async () => {
    const match = await createCoach({ city: 'Berlin', sports: ['tennis'], hourlyPrice: 40 });
    await createCoach({ city: 'Berlin', sports: ['tennis'], hourlyPrice: 200, email: uniqueEmail('pricey') });
    await createCoach({ city: 'Munich', sports: ['tennis'], hourlyPrice: 40, email: uniqueEmail('munich') });
    await createCoach({ city: 'Berlin', sports: ['boxing'], hourlyPrice: 40, email: uniqueEmail('boxer') });

    const response = await api()
      .get('/api/v1/coaches')
      .query({ sport: 'tennis', city: 'Berlin', maxPrice: 50 });

    expect(response.body.data.map((coach: { id: string }) => coach.id)).toEqual([match.coachProfileId]);
  });

  it('computes distance and restricts results with radiusKm', async () => {
    const berlinCoach = await createCoach({ city: 'Berlin', ...BERLIN });
    const hamburgCoach = await createCoach({
      city: 'Hamburg',
      neighborhood: 'Altona',
      ...HAMBURG,
      email: uniqueEmail('hamburg'),
    });

    const nearby = await api()
      .get('/api/v1/coaches')
      .query({ ...BERLIN, radiusKm: 50, sort: 'distance_asc' });

    expect(nearby.status).toBe(200);
    expect(nearby.body.data.map((coach: { id: string }) => coach.id)).toEqual([berlinCoach.coachProfileId]);
    expect(nearby.body.data[0].distanceKm).toBeCloseTo(0, 3);

    const wide = await api()
      .get('/api/v1/coaches')
      .query({ ...BERLIN, radiusKm: 400, sort: 'distance_asc' });

    expect(wide.body.data.map((coach: { id: string }) => coach.id)).toEqual([
      berlinCoach.coachProfileId,
      hamburgCoach.coachProfileId,
    ]);

    // The SQL implementation must agree with the JavaScript reference implementation.
    const expectedHamburgDistance = haversineDistanceKm(BERLIN, HAMBURG);
    expect(wide.body.data[1].distanceKm).toBeCloseTo(expectedHamburgDistance, 1);

    const farOnly = await api()
      .get('/api/v1/coaches')
      .query({ ...HAMBURG, radiusKm: 50, sort: 'distance_asc' });

    expect(farOnly.body.data.map((coach: { id: string }) => coach.id)).toEqual([hamburgCoach.coachProfileId]);
  });

  it('sorts by price and rating', async () => {
    const cheap = await createCoach({ hourlyPrice: 20, email: uniqueEmail('cheap') });
    const expensive = await createCoach({ hourlyPrice: 80, email: uniqueEmail('expensive') });

    const byPriceAsc = await api().get('/api/v1/coaches').query({ sort: 'price_asc' });
    expect(byPriceAsc.body.data.map((coach: { id: string }) => coach.id)).toEqual([
      cheap.coachProfileId,
      expensive.coachProfileId,
    ]);

    const byPriceDesc = await api().get('/api/v1/coaches').query({ sort: 'price_desc' });
    expect(byPriceDesc.body.data.map((coach: { id: string }) => coach.id)).toEqual([
      expensive.coachProfileId,
      cheap.coachProfileId,
    ]);

    // A review lifts the pricier coach to the top of a rating sort.
    const client = await registerUser();
    const booking = await completeBooking(client.token, expensive.token, expensive.coachProfileId, dayWindow(2, 11));
    await api()
      .post(`/api/v1/bookings/${booking.body.data.id}/review`)
      .set('Authorization', bearer(client.token))
      .send({ rating: 5, comment: 'Great session with clear feedback.' });

    const byRating = await api().get('/api/v1/coaches').query({ sort: 'rating_desc' });
    expect(byRating.body.data[0].id).toBe(expensive.coachProfileId);
    expect(byRating.body.data[0].averageRating).toBe(5);
  });

  it('paginates with metadata', async () => {
    for (let index = 0; index < 5; index += 1) {
      await createCoach({ email: uniqueEmail(`page${index}`), hourlyPrice: 10 + index });
    }

    const firstPage = await api().get('/api/v1/coaches').query({ page: 1, limit: 2, sort: 'price_asc' });

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.meta).toMatchObject({
      page: 1,
      limit: 2,
      total: 5,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });

    const lastPage = await api().get('/api/v1/coaches').query({ page: 3, limit: 2, sort: 'price_asc' });
    expect(lastPage.body.data).toHaveLength(1);
    expect(lastPage.body.meta.hasNextPage).toBe(false);
    expect(lastPage.body.meta.hasPreviousPage).toBe(true);

    // Pages must not overlap.
    const firstIds = firstPage.body.data.map((coach: { id: string }) => coach.id);
    const secondPage = await api().get('/api/v1/coaches').query({ page: 2, limit: 2, sort: 'price_asc' });
    const secondIds = secondPage.body.data.map((coach: { id: string }) => coach.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });

  it('validates search parameters', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['limit above the maximum', { limit: 101 }],
      ['page below 1', { page: 0 }],
      ['latitude without longitude', { latitude: 52.5 }],
      ['longitude without latitude', { longitude: 13.4 }],
      ['radius without coordinates', { radiusKm: 10 }],
      ['distance sort without coordinates', { sort: 'distance_asc' }],
      ['latitude out of range', { latitude: 120, longitude: 13 }],
      ['longitude out of range', { latitude: 52, longitude: 400 }],
      ['negative minimum price', { minPrice: -5 }],
      ['minPrice above maxPrice', { minPrice: 100, maxPrice: 10 }],
      ['minimum rating above 5', { minRating: 6 }],
      ['unknown sort key', { sort: 'cheapest' }],
      ['non-numeric page', { page: 'abc' }],
    ];

    for (const [label, query] of cases) {
      const response = await api().get('/api/v1/coaches').query(query);
      expect(response.status, `${label} should be rejected`).toBe(400);
      expect(response.body.error.code, label).toBe('VALIDATION_ERROR');
    }
  });

  it('returns a published coach detail with upcoming availability', async () => {
    const coach = await createCoach({ sports: ['football'] });

    const response = await api().get(`/api/v1/coaches/${coach.coachProfileId}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: coach.coachProfileId,
      coachName: 'Test Coach',
      hourlyPrice: '45.00',
      reviewCount: 0,
      totalBookings: 0,
    });
    expect(response.body.data.availability.length).toBeGreaterThan(0);
    expect(response.body.data.availability[0]).toHaveProperty('startAt');
  });

  it('hides unpublished profiles and unknown ids (404) and rejects malformed ids (400)', async () => {
    const draft = await createCoach({ published: false });

    const unpublished = await api().get(`/api/v1/coaches/${draft.coachProfileId}`);
    expect(unpublished.status).toBe(404);

    const unknown = await api().get('/api/v1/coaches/00000000-0000-0000-0000-000000000000');
    expect(unknown.status).toBe(404);

    const malformed = await api().get('/api/v1/coaches/not-a-uuid');
    expect(malformed.status).toBe(400);
  });
});

describe('Coach profile management', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('creates a profile that starts unpublished', async () => {
    const coach = await registerUser({ role: 'COACH' });

    const response = await api()
      .post('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({
        bio: 'Marathon runner and running coach with ten years of experience coaching adults.',
        hourlyPrice: 55.5,
        experienceLevel: 'PROFESSIONAL',
        city: 'Cologne',
        neighborhood: 'Ehrenfeld',
        latitude: 50.9375,
        longitude: 6.9603,
        address: 'Venloer Str. 1',
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      userId: coach.id,
      city: 'Cologne',
      hourlyPrice: '55.50',
      experienceLevel: 'PROFESSIONAL',
      isPublished: false,
    });
  });

  it('rejects a second profile for the same coach with 409', async () => {
    const coach = await createCoach();

    const response = await api()
      .post('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({
        bio: 'A second profile that must not be created for the same coach account.',
        hourlyPrice: 30,
        experienceLevel: 'BEGINNER',
        city: 'Berlin',
        neighborhood: 'Kreuzberg',
      });

    expect(response.status).toBe(409);
  });

  it('requires coordinates and at least one sport before publishing', async () => {
    const coach = await registerUser({ role: 'COACH' });

    await api()
      .post('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({
        bio: 'Weightlifting coach preparing athletes for regional competitions.',
        hourlyPrice: 40,
        experienceLevel: 'ADVANCED',
        city: 'Leipzig',
        neighborhood: 'Zentrum',
      });

    const withoutSport = await api()
      .patch('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({ isPublished: true, latitude: 51.34, longitude: 12.37 });

    expect(withoutSport.status).toBe(400);
    expect(String(withoutSport.body.error.message)).toContain('at least one sport');

    await api()
      .put('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportSlugs: ['fitness'] });

    // Coordinates were never provided, so publishing is still refused.
    const withoutCoordinates = await api()
      .patch('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({ isPublished: true });

    expect(withoutCoordinates.status).toBe(400);
    expect(String(withoutCoordinates.body.error.message)).toContain('latitude and longitude');

    const published = await api()
      .patch('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({ isPublished: true, latitude: 51.34, longitude: 12.37 });

    expect(published.status).toBe(200);
    expect(published.body.data.isPublished).toBe(true);
  });

  it('updates profile fields', async () => {
    const coach = await createCoach({ hourlyPrice: 40 });

    const response = await api()
      .patch('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({ hourlyPrice: 62.25, city: 'Potsdam', neighborhood: 'Babelsberg', address: 'Karl-Marx-Str. 5' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ hourlyPrice: '62.25', city: 'Potsdam', neighborhood: 'Babelsberg' });
  });

  it('returns 404 when a coach has no profile yet', async () => {
    const coach = await registerUser({ role: 'COACH' });

    const response = await api().get('/api/v1/coaches/me/profile').set('Authorization', bearer(coach.token));

    expect(response.status).toBe(404);
  });

  it('returns empty sports and availability for a newly registered coach', async () => {
    const coach = await registerUser({ role: 'COACH' });

    const anonymousSports = await api().get('/api/v1/coaches/me/sports');
    const anonymousAvailability = await api().get('/api/v1/coaches/me/availability');
    expect(anonymousSports.status).toBe(401);
    expect(anonymousAvailability.status).toBe(401);

    const sportsWithUnsupportedQuery = await api()
      .get('/api/v1/coaches/me/sports')
      .query({ coachId: coach.id })
      .set('Authorization', bearer(coach.token));
    const availabilityWithUnsupportedQuery = await api()
      .get('/api/v1/coaches/me/availability')
      .query({ coachId: coach.id })
      .set('Authorization', bearer(coach.token));
    expect(sportsWithUnsupportedQuery.status).toBe(400);
    expect(availabilityWithUnsupportedQuery.status).toBe(400);

    const sports = await api().get('/api/v1/coaches/me/sports').set('Authorization', bearer(coach.token));
    const availability = await api()
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(coach.token));

    expect(sports.status).toBe(200);
    expect(sports.body.data).toEqual([]);
    expect(availability.status).toBe(200);
    expect(availability.body.data).toEqual([]);
  });

  it('keeps sports and availability scoped to the authenticated coach', async () => {
    const firstCoach = await createCoach({ sports: ['boxing'], availabilityDays: 1 });
    const secondCoach = await createCoach({ sports: ['swimming'], availabilityDays: 1 });

    const firstSports = await api()
      .get('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(firstCoach.token));
    const secondSports = await api()
      .get('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(secondCoach.token));
    const firstAvailability = await api()
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(firstCoach.token));
    const secondAvailability = await api()
      .get('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(secondCoach.token));

    expect(firstSports.body.data.map((sport: { slug: string }) => sport.slug)).toEqual(['boxing']);
    expect(secondSports.body.data.map((sport: { slug: string }) => sport.slug)).toEqual(['swimming']);
    expect(firstAvailability.body.data).toHaveLength(1);
    expect(secondAvailability.body.data).toHaveLength(1);
    expect(firstAvailability.body.data[0].id).not.toBe(secondAvailability.body.data[0].id);
  });

  it('manages offered sports', async () => {
    const coach = await createCoach({ sports: ['fitness', 'boxing'] });

    const replaced = await api()
      .put('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportSlugs: ['tennis'] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.map((sport: { slug: string }) => sport.slug)).toEqual(['tennis']);

    const catalog = await api().get('/api/v1/sports');
    const tennis = catalog.body.data.find((sport: { slug: string }) => sport.slug === 'tennis');
    const replacedByIds = await api()
      .put('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportIds: [tennis.id] });
    expect(replacedByIds.status).toBe(200);
    expect(replacedByIds.body.data.map((sport: { id: string }) => sport.id)).toEqual([tennis.id]);

    const reloaded = await api()
      .get('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token));
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data.map((sport: { id: string }) => sport.id)).toEqual([tennis.id]);

    const cleared = await api()
      .put('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toEqual([]);
    const clearedOnReload = await api()
      .get('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token));
    expect(clearedOnReload.body.data).toEqual([]);

    const unknown = await api()
      .put('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportSlugs: ['tennis', 'quidditch'] });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error.message)).toContain('quidditch');

    const added = await api()
      .post('/api/v1/coaches/me/sports')
      .set('Authorization', bearer(coach.token))
      .send({ sportId: tennis.id });
    expect(added.status).toBe(201);

    const removed = await api()
      .delete(`/api/v1/coaches/me/sports/${tennis.id}`)
      .set('Authorization', bearer(coach.token));
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual([]);

    const removeAgain = await api()
      .delete(`/api/v1/coaches/me/sports/${tennis.id}`)
      .set('Authorization', bearer(coach.token));
    expect(removeAgain.status).toBe(404);
  });

  it('manages availability windows and rejects overlaps', async () => {
    const coach = await registerUser({ role: 'COACH' });
    await api()
      .post('/api/v1/coaches/me/profile')
      .set('Authorization', bearer(coach.token))
      .send({
        bio: 'Yoga and mobility coach for desk workers with limited flexibility.',
        hourlyPrice: 35,
        experienceLevel: 'INTERMEDIATE',
        city: 'Berlin',
        neighborhood: 'Prenzlauer Berg',
        latitude: 52.54,
        longitude: 13.42,
      });

    const window = dayWindow(3, 9, 4);

    const created = await api()
      .post('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(coach.token))
      .send(window);
    expect(created.status).toBe(201);
    expect(created.body.data).toHaveLength(1);

    const overlapping = await api()
      .post('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(coach.token))
      .send({ startAt: window.startAt, endAt: window.endAt });
    expect(overlapping.status).toBe(409);

    const invalidRange = await api()
      .post('/api/v1/coaches/me/availability')
      .set('Authorization', bearer(coach.token))
      .send({ startAt: window.endAt, endAt: window.startAt });
    expect(invalidRange.status).toBe(400);

    const availabilityId = created.body.data[0].id;
    const deleted = await api()
      .delete(`/api/v1/coaches/me/availability/${availabilityId}`)
      .set('Authorization', bearer(coach.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual([]);

    const deleteAgain = await api()
      .delete(`/api/v1/coaches/me/availability/${availabilityId}`)
      .set('Authorization', bearer(coach.token));
    expect(deleteAgain.status).toBe(404);
  });
});

describe('Sports catalogue', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('lists the seeded sports with published coach counts', async () => {
    await createCoach({ sports: ['boxing'] });

    const response = await api().get('/api/v1/sports');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(5);
    const boxing = response.body.data.find((sport: { slug: string }) => sport.slug === 'boxing');
    expect(boxing).toMatchObject({ name: 'Boxing', coachCount: 1 });
  });
});

/** Local helper: a booking window `dayOffset` days from today starting at `hour` UTC. */
function dayWindow(dayOffset: number, hour: number, durationHours = 1): { startAt: string; endAt: string } {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() + dayOffset);
  start.setUTCHours(hour, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + durationHours * 3_600_000).toISOString() };
}
