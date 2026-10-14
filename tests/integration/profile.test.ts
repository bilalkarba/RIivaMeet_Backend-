import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, createCoach, registerUser, uniqueEmail } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Profile endpoints (Phase 1).
 *
 * Verifies the self-service profile, the privacy-safe public projection, and the
 * athlete discipline management. The public projection must never leak email/phone.
 */
describe('Profiles', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('GET/PATCH /api/v1/profile/me', () => {
    it('requires authentication', async () => {
      const response = await api().get('/api/v1/profile/me');
      expect(response.status).toBe(401);
    });

    it('returns a freshly registered account with empty profile fields', async () => {
      const user = await registerUser();

      const response = await api().get('/api/v1/profile/me').set('Authorization', bearer(user.token));

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: user.id,
        displayName: null,
        avatarUrl: null,
        bio: null,
        city: null,
        country: null,
        level: null,
        role: 'CLIENT',
        sports: [],
        hasCoachProfile: false,
      });
    });

    it('updates profile fields and persists them', async () => {
      const user = await registerUser();

      const updated = await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({
          displayName: 'Speedy',
          avatarUrl: 'https://cdn.example.com/avatars/me.png',
          bio: 'Runner and cyclist',
          city: 'Lyon',
          country: 'France',
          level: 'INTERMEDIATE',
        });

      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({
        displayName: 'Speedy',
        city: 'Lyon',
        country: 'France',
        level: 'INTERMEDIATE',
      });

      const readBack = await api().get('/api/v1/profile/me').set('Authorization', bearer(user.token));
      expect(readBack.body.data.displayName).toBe('Speedy');
    });

    it('clears a field when null is sent and leaves the rest untouched', async () => {
      const user = await registerUser();

      await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({ displayName: 'Temp', city: 'Paris' });

      const cleared = await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({ displayName: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body.data.displayName).toBeNull();
      expect(cleared.body.data.city).toBe('Paris');
    });

    it('rejects unknown fields, bad avatar URLs and empty bodies', async () => {
      const user = await registerUser();

      const unknown = await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({ nickname: 'nope' });
      expect(unknown.status).toBe(400);

      const badUrl = await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({ avatarUrl: 'javascript:alert(1)' });
      expect(badUrl.status).toBe(400);

      const empty = await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({});
      expect(empty.status).toBe(400);
    });
  });

  describe('GET /api/v1/profile/:userId', () => {
    it('returns a public projection without email or phone', async () => {
      const user = await registerUser({ phone: '+4915112345678' });

      await api()
        .patch('/api/v1/profile/me')
        .set('Authorization', bearer(user.token))
        .send({ displayName: 'Public Name', city: 'Berlin', country: 'Germany' });

      const response = await api().get(`/api/v1/profile/${user.id}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ displayName: 'Public Name', city: 'Berlin', isCoach: false });
      expect(response.body.data).not.toHaveProperty('email');
      expect(response.body.data).not.toHaveProperty('phone');
      expect(JSON.stringify(response.body)).not.toContain('+4915112345678');
    });

    it('falls back to the account name when no display name is set', async () => {
      const user = await registerUser({ name: 'Account Name' });
      const response = await api().get(`/api/v1/profile/${user.id}`);
      expect(response.body.data.displayName).toBe('Account Name');
    });

    it('links the coach profile when the user is a coach', async () => {
      const coach = await createCoach();
      const response = await api().get(`/api/v1/profile/${coach.id}`);

      expect(response.status).toBe(200);
      expect(response.body.data.isCoach).toBe(true);
      expect(response.body.data.coachProfileId).toBe(coach.coachProfileId);
    });

    it('returns 404 for an unknown user and 400 for a malformed id', async () => {
      const missing = await api().get('/api/v1/profile/00000000-0000-0000-0000-000000000000');
      expect(missing.status).toBe(404);

      const malformed = await api().get('/api/v1/profile/not-a-uuid');
      expect(malformed.status).toBe(400);
    });
  });

  describe('athlete disciplines', () => {
    it('replaces, adds and removes disciplines', async () => {
      const user = await registerUser();
      const auth = { Authorization: bearer(user.token) };

      const replaced = await api()
        .put('/api/v1/profile/me/sports')
        .set(auth)
        .send({ sportSlugs: ['boxing', 'fitness'], level: 'BEGINNER' });
      expect(replaced.status).toBe(200);
      expect(replaced.body.data.map((s: { slug: string }) => s.slug).sort()).toEqual(['boxing', 'fitness']);
      expect(replaced.body.data[0].level).toBe('BEGINNER');

      // Replace is idempotent and drops the disciplines that are no longer listed.
      const replacedAgain = await api().put('/api/v1/profile/me/sports').set(auth).send({ sportSlugs: ['tennis'] });
      expect(replacedAgain.body.data.map((s: { slug: string }) => s.slug)).toEqual(['tennis']);

      const sports = await api().get('/api/v1/sports');
      const tennis = sports.body.data.find((s: { slug: string }) => s.slug === 'tennis');
      await api().delete(`/api/v1/profile/me/sports/${tennis.id}`).set(auth);

      const list = await api().get('/api/v1/profile/me/sports').set(auth);
      expect(list.body.data).toEqual([]);
    });

    it('rejects an unknown discipline with 400', async () => {
      const user = await registerUser();
      const response = await api()
        .put('/api/v1/profile/me/sports')
        .set('Authorization', bearer(user.token))
        .send({ sportSlugs: ['quidditch'] });
      expect(response.status).toBe(400);
    });

    it('returns 404 when removing a discipline that is not set', async () => {
      const user = await registerUser();
      const sports = await api().get('/api/v1/sports');
      const fitness = sports.body.data.find((s: { slug: string }) => s.slug === 'fitness');

      const response = await api()
        .delete(`/api/v1/profile/me/sports/${fitness.id}`)
        .set('Authorization', bearer(user.token));
      expect(response.status).toBe(404);
    });

    it('isolates disciplines per user', async () => {
      const a = await registerUser({ email: uniqueEmail('athlete-a') });
      const b = await registerUser({ email: uniqueEmail('athlete-b') });

      await api()
        .put('/api/v1/profile/me/sports')
        .set('Authorization', bearer(a.token))
        .send({ sportSlugs: ['swimming'] });

      const listB = await api().get('/api/v1/profile/me/sports').set('Authorization', bearer(b.token));
      expect(listB.body.data).toEqual([]);
    });
  });
});
