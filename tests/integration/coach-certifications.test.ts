import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, createCoach, registerUser } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Coach certifications (Phase 1 profile field required by the specification).
 *
 * They must round-trip through create/update, appear in the public read models, and be
 * validated (count and length limits).
 */
describe('Coach certifications', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('persists certifications on the profile and in search results', async () => {
    const coach = await createCoach({
      sports: ['fitness'],
      certifications: ['UEFA B Licence', 'First Aid Certificate'],
    });

    const mine = await api().get('/api/v1/coaches/me/profile').set('Authorization', bearer(coach.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.certifications).toEqual(['UEFA B Licence', 'First Aid Certificate']);

    const search = await api().get('/api/v1/coaches');
    const found = search.body.data.find((c: { id: string }) => c.id === coach.coachProfileId);
    expect(found.certifications).toEqual(['UEFA B Licence', 'First Aid Certificate']);
  });

  it('replaces certifications on update, including clearing them', async () => {
    const coach = await createCoach({ certifications: ['Old Certificate'] });
    const auth = { Authorization: bearer(coach.token) };

    const replaced = await api()
      .patch('/api/v1/coaches/me/profile')
      .set(auth)
      .send({ certifications: ['New Certificate'] });
    expect(replaced.body.data.certifications).toEqual(['New Certificate']);

    const cleared = await api().patch('/api/v1/coaches/me/profile').set(auth).send({ certifications: [] });
    expect(cleared.body.data.certifications).toEqual([]);
  });

  it('rejects too many or malformed certifications', async () => {
    const coach = await createCoach();
    const auth = { Authorization: bearer(coach.token) };

    const tooMany = await api()
      .patch('/api/v1/coaches/me/profile')
      .set(auth)
      .send({ certifications: Array.from({ length: 21 }, (_, index) => `Certificate ${index}`) });
    expect(tooMany.status).toBe(400);

    const tooShort = await api()
      .patch('/api/v1/coaches/me/profile')
      .set(auth)
      .send({ certifications: ['x'] });
    expect(tooShort.status).toBe(400);

    const notAnArray = await api()
      .patch('/api/v1/coaches/me/profile')
      .set(auth)
      .send({ certifications: 'UEFA B Licence' });
    expect(notAnArray.status).toBe(400);
  });

  it('defaults to an empty list for profiles created without certifications', async () => {
    await registerUser();
    const coach = await createCoach();
    const mine = await api().get('/api/v1/coaches/me/profile').set('Authorization', bearer(coach.token));
    expect(mine.body.data.certifications).toEqual([]);
  });
});
