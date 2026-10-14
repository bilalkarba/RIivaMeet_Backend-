import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, createCoach, registerUser } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Compatible-profile suggestions + extended coach search filters (Phase 1).
 *
 * The viewer's own disciplines, level and location drive the ranking, so these tests
 * assert both the ordering and the filter semantics.
 */
describe('Matching', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function setCountry(token: string, country: string): Promise<void> {
    const response = await api().patch('/api/v1/profile/me').set('Authorization', bearer(token)).send({ country });
    expect(response.status).toBe(200);
  }

  it('requires authentication', async () => {
    const response = await api().get('/api/v1/matches/suggestions');
    expect(response.status).toBe(401);
  });

  it('ranks coaches sharing the viewer disciplines first', async () => {
    const boxing = await createCoach({ sports: ['boxing'], name: 'Boxing Coach' });
    const swimming = await createCoach({ sports: ['swimming'], name: 'Swimming Coach', email: undefined });

    const viewer = await registerUser();
    await api()
      .put('/api/v1/profile/me/sports')
      .set('Authorization', bearer(viewer.token))
      .send({ sportSlugs: ['boxing'] });

    const response = await api().get('/api/v1/matches/suggestions').set('Authorization', bearer(viewer.token));

    expect(response.status).toBe(200);
    expect(response.body.data[0].id).toBe(boxing.coachProfileId);
    expect(response.body.meta.basis.sports).toContain('Boxing');
    const ids = response.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(swimming.coachProfileId);
  });

  it('never suggests the viewer their own coach profile', async () => {
    const coach = await createCoach({ sports: ['fitness'] });

    const response = await api()
      .get('/api/v1/matches/suggestions')
      .set('Authorization', bearer(coach.token));

    expect(response.status).toBe(200);
    const ids = response.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(coach.coachProfileId);
  });

  it('filters suggestions by discipline, level and country', async () => {
    const german = await createCoach({
      sports: ['boxing'],
      experienceLevel: 'ADVANCED',
      city: 'Berlin',
      name: 'German Coach',
    });
    await setCountry(german.token, 'Germany');

    const french = await createCoach({
      sports: ['boxing'],
      experienceLevel: 'BEGINNER',
      city: 'Lyon',
      name: 'French Coach',
    });
    await setCountry(french.token, 'France');

    const viewer = await registerUser();
    const auth = { Authorization: bearer(viewer.token) };

    const byCountry = await api().get('/api/v1/matches/suggestions?country=Germany').set(auth);
    expect(byCountry.body.data.map((c: { id: string }) => c.id)).toEqual([german.coachProfileId]);

    const byLevel = await api().get('/api/v1/matches/suggestions?level=BEGINNER').set(auth);
    expect(byLevel.body.data.map((c: { id: string }) => c.id)).toEqual([french.coachProfileId]);

    const bySport = await api().get('/api/v1/matches/suggestions?sport=boxing').set(auth);
    expect(bySport.body.data).toHaveLength(2);
  });

  it('applies a radius filter when coordinates are supplied', async () => {
    const berlin = await createCoach({
      sports: ['fitness'],
      city: 'Berlin',
      latitude: 52.520008,
      longitude: 13.404954,
      name: 'Berlin Coach',
    });
    const hamburg = await createCoach({
      sports: ['fitness'],
      city: 'Hamburg',
      latitude: 53.551086,
      longitude: 9.993682,
      name: 'Hamburg Coach',
    });

    const viewer = await registerUser();
    const response = await api()
      .get('/api/v1/matches/suggestions?latitude=52.520008&longitude=13.404954&radiusKm=50')
      .set('Authorization', bearer(viewer.token));

    expect(response.status).toBe(200);
    const ids = response.body.data.map((c: { id: string }) => c.id);
    expect(ids).toEqual([berlin.coachProfileId]);
    expect(ids).not.toContain(hamburg.coachProfileId);
  });

  it('rejects radiusKm without coordinates', async () => {
    const viewer = await registerUser();
    const response = await api()
      .get('/api/v1/matches/suggestions?radiusKm=10')
      .set('Authorization', bearer(viewer.token));
    expect(response.status).toBe(400);
  });

  it('supports the new level and country filters on coach search', async () => {
    const coach = await createCoach({ sports: ['swimming'], experienceLevel: 'PROFESSIONAL', city: 'Hamburg' });
    await setCountry(coach.token, 'Germany');

    const matchesLevel = await api().get('/api/v1/coaches?level=PROFESSIONAL');
    expect(matchesLevel.body.data.map((c: { id: string }) => c.id)).toContain(coach.coachProfileId);

    const wrongLevel = await api().get('/api/v1/coaches?level=BEGINNER');
    expect(wrongLevel.body.data.map((c: { id: string }) => c.id)).not.toContain(coach.coachProfileId);

    const matchesCountry = await api().get('/api/v1/coaches?country=Germany');
    expect(matchesCountry.body.data.map((c: { id: string }) => c.id)).toContain(coach.coachProfileId);

    const invalidLevel = await api().get('/api/v1/coaches?level=EXPERT');
    expect(invalidLevel.status).toBe(400);
  });
});
