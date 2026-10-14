import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, registerUser, uniqueEmail, TEST_PASSWORD } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

describe('Authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('POST /api/v1/auth/register', () => {
    it('registers a CLIENT and returns an access token without any password material', async () => {
      const email = uniqueEmail('newclient');

      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email, password: TEST_PASSWORD, name: 'New Client' });

      expect(response.status).toBe(201);
      expect(response.body.data.user).toMatchObject({
        email,
        name: 'New Client',
        role: 'CLIENT',
        hasCoachProfile: false,
      });
      expect(typeof response.body.data.accessToken).toBe('string');
      expect(response.body.data.accessToken.split('.')).toHaveLength(3);
      expect(response.body.data.tokenType).toBe('Bearer');

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('password_hash');
      expect(serialized).not.toContain(TEST_PASSWORD);
    });

    it('registers a COACH account', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('newcoach'), password: TEST_PASSWORD, name: 'New Coach', role: 'COACH' });

      expect(response.status).toBe(201);
      expect(response.body.data.user.role).toBe('COACH');
    });

    it('normalizes the email to lower case and trims it', async () => {
      const email = uniqueEmail('MixedCase');

      const registered = await api()
        .post('/api/v1/auth/register')
        .send({ email: `  ${email.toUpperCase()}  `, password: TEST_PASSWORD, name: 'Case Test' });

      expect(registered.status).toBe(201);
      expect(registered.body.data.user.email).toBe(email.toLowerCase());

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email: email.toLowerCase(), password: TEST_PASSWORD });

      expect(login.status).toBe(200);
      expect(login.body.data.user.id).toBe(registered.body.data.user.id);
    });

    it('rejects a duplicate email with 409 regardless of casing', async () => {
      const email = uniqueEmail('dup');
      await api().post('/api/v1/auth/register').send({ email, password: TEST_PASSWORD, name: 'First' });

      const duplicate = await api()
        .post('/api/v1/auth/register')
        .send({ email: email.toUpperCase(), password: TEST_PASSWORD, name: 'Second' });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('CONFLICT');
    });

    it('rejects an ADMIN role (no public privilege escalation)', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('admin'), password: TEST_PASSWORD, name: 'Sneaky Admin', role: 'ADMIN' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('CLIENT or COACH');
    });

    it('rejects unknown fields instead of ignoring them', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail('extra'), password: TEST_PASSWORD, name: 'Extra', isAdmin: true });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each([
      ['invalid email', { email: 'not-an-email', password: TEST_PASSWORD, name: 'A B' }],
      ['short password', { email: uniqueEmail('short'), password: 'abc1', name: 'A B' }],
      ['password without a number', { email: uniqueEmail('noNum'), password: 'abcdefghij', name: 'A B' }],
      ['missing name', { email: uniqueEmail('noName'), password: TEST_PASSWORD }],
      ['short name', { email: uniqueEmail('shortName'), password: TEST_PASSWORD, name: 'A' }],
    ])('rejects %s with 400 and structured details', async (_label, payload) => {
      const response = await api().post('/api/v1/auth/register').send(payload);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(response.body.error.details)).toBe(true);
      expect(response.body.error.details.length).toBeGreaterThan(0);
      expect(response.body.error.details[0]).toHaveProperty('path');
      expect(response.body.error.details[0]).toHaveProperty('message');
    });

    it('rejects a malformed JSON body with 400', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .set('Content-Type', 'application/json')
        .send('{"email": "broken"');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns a token for valid credentials', async () => {
      const user = await registerUser();

      const response = await api().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body.data.user.id).toBe(user.id);
      expect(response.body.data.accessToken).toBeTruthy();
      expect(response.body.data.user).not.toHaveProperty('passwordHash');
    });

    it('rejects a wrong password with 401', async () => {
      const user = await registerUser();

      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'WrongPassw0rd' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns the same 401 for an unknown email (no account enumeration)', async () => {
      const known = await registerUser();

      const wrongPassword = await api()
        .post('/api/v1/auth/login')
        .send({ email: known.email, password: 'WrongPassw0rd' });

      const unknownEmail = await api()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: TEST_PASSWORD });

      expect(unknownEmail.status).toBe(401);
      expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('rejects a missing password with 400', async () => {
      const user = await registerUser();

      const response = await api().post('/api/v1/auth/login').send({ email: user.email });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('returns the signed-in user', async () => {
      const user = await registerUser({ role: 'COACH' });

      const response = await api().get('/api/v1/auth/me').set('Authorization', bearer(user.token));

      expect(response.status).toBe(200);
      expect(response.body.data.user).toMatchObject({ id: user.id, email: user.email, role: 'COACH' });
    });

    it('rejects missing, malformed and tampered tokens with 401', async () => {
      const user = await registerUser();

      const missing = await api().get('/api/v1/auth/me');
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('UNAUTHORIZED');

      const malformed = await api().get('/api/v1/auth/me').set('Authorization', 'Token abc');
      expect(malformed.status).toBe(401);

      const garbage = await api().get('/api/v1/auth/me').set('Authorization', bearer('not.a.jwt'));
      expect(garbage.status).toBe(401);

      // Valid signature structure but tampered payload.
      const [header, , signature] = user.token.split('.');
      const forged = `${header}.${Buffer.from(JSON.stringify({ sub: user.id, role: 'ADMIN', email: user.email })).toString('base64url')}.${signature}`;

      const tampered = await api().get('/api/v1/auth/me').set('Authorization', bearer(forged));
      expect(tampered.status).toBe(401);
    });
  });

  describe('role-based authorization', () => {
    it('forbids a CLIENT from creating a coach profile', async () => {
      const client = await registerUser({ role: 'CLIENT' });

      const response = await api()
        .post('/api/v1/coaches/me/profile')
        .set('Authorization', bearer(client.token))
        .send({
          bio: 'I should not be allowed to create a coach profile at all.',
          hourlyPrice: 30,
          experienceLevel: 'BEGINNER',
          city: 'Berlin',
          neighborhood: 'Mitte',
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('forbids a COACH from requesting a booking (clients only)', async () => {
      const coach = await registerUser({ role: 'COACH' });

      const response = await api()
        .post('/api/v1/bookings')
        .set('Authorization', bearer(coach.token))
        .send({
          coachProfileId: '00000000-0000-0000-0000-000000000000',
          startAt: new Date(Date.now() + 86_400_000).toISOString(),
          endAt: new Date(Date.now() + 90_000_000).toISOString(),
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('forbids a CLIENT from accepting a booking (coaches only)', async () => {
      const client = await registerUser({ role: 'CLIENT' });

      const response = await api()
        .patch('/api/v1/bookings/00000000-0000-0000-0000-000000000000/accept')
        .set('Authorization', bearer(client.token));

      expect(response.status).toBe(403);
    });

    it('requires authentication on private routes', async () => {
      const me = await api().get('/api/v1/auth/me');
      const profile = await api().get('/api/v1/coaches/me/profile');
      const bookings = await api().get('/api/v1/bookings/mine');

      expect(me.status).toBe(401);
      expect(profile.status).toBe(401);
      expect(bookings.status).toBe(401);
    });

    it('exposes public endpoints without authentication', async () => {
      const sports = await api().get('/api/v1/sports');
      const coaches = await api().get('/api/v1/coaches');

      expect(sports.status).toBe(200);
      expect(coaches.status).toBe(200);
      expect(sports.body.data.map((sport: { slug: string }) => sport.slug)).toEqual([
        'boxing',
        'fitness',
        'football',
        'swimming',
        'tennis',
      ]);
    });
  });

  describe('service endpoints', () => {
    it('reports health including the database check', async () => {
      const response = await api().get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.checks.database).toBe('up');
    });

    it('returns a structured 404 for unknown routes', async () => {
      const response = await api().get('/api/v1/does-not-exist');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.requestId).toBeTruthy();
      expect(response.headers['x-request-id']).toBeTruthy();
    });
  });
});
