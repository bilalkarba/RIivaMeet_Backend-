import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, createCoach, registerAdmin, registerUser, uniqueEmail } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Blocking, reporting and admin moderation (Phase 2).
 *
 * Privilege boundaries matter here: a reporter must never see moderation internals and
 * a non-admin must never reach the moderation queue.
 */
describe('Safety', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('blocks', () => {
    it('requires authentication', async () => {
      expect((await api().get('/api/v1/blocks')).status).toBe(401);
      expect((await api().post('/api/v1/blocks').send({ userId: 'x' })).status).toBe(401);
    });

    it('blocks, lists and unblocks a user', async () => {
      const a = await registerUser({ email: uniqueEmail('blocker') });
      const b = await registerUser({ email: uniqueEmail('blocked') });
      const auth = { Authorization: bearer(a.token) };

      const blocked = await api().post('/api/v1/blocks').set(auth).send({ userId: b.id });
      expect(blocked.status).toBe(201);
      expect(blocked.body.data.map((u: { id: string }) => u.id)).toEqual([b.id]);

      const listed = await api().get('/api/v1/blocks').set(auth);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].id).toBe(b.id);

      const unblocked = await api().delete(`/api/v1/blocks/${b.id}`).set(auth);
      expect(unblocked.status).toBe(200);
      expect(unblocked.body.data).toEqual([]);
    });

    it('is idempotent and rejects self-blocks and unknown users', async () => {
      const a = await registerUser();
      const b = await registerUser({ email: uniqueEmail('other') });
      const auth = { Authorization: bearer(a.token) };

      await api().post('/api/v1/blocks').set(auth).send({ userId: b.id });
      const again = await api().post('/api/v1/blocks').set(auth).send({ userId: b.id });
      expect(again.status).toBe(201);
      expect(again.body.data).toHaveLength(1);

      const self = await api().post('/api/v1/blocks').set(auth).send({ userId: a.id });
      expect(self.status).toBe(400);

      const unknown = await api()
        .post('/api/v1/blocks')
        .set(auth)
        .send({ userId: '00000000-0000-0000-0000-000000000000' });
      expect(unknown.status).toBe(404);

      const notBlocked = await api().delete('/api/v1/blocks/00000000-0000-0000-0000-000000000000').set(auth);
      expect(notBlocked.status).toBe(404);
    });

    it('hides blocked coaches from search and suggestions', async () => {
      const coach = await createCoach({ sports: ['fitness'] });
      const viewer = await registerUser({ email: uniqueEmail('viewer') });
      const auth = { Authorization: bearer(viewer.token) };

      const before = await api().get('/api/v1/coaches').set(auth);
      expect(before.body.data.map((c: { id: string }) => c.id)).toContain(coach.coachProfileId);

      await api().post('/api/v1/blocks').set(auth).send({ userId: coach.id });

      const after = await api().get('/api/v1/coaches').set(auth);
      expect(after.body.data.map((c: { id: string }) => c.id)).not.toContain(coach.coachProfileId);

      const suggestions = await api().get('/api/v1/matches/suggestions').set(auth);
      expect(suggestions.body.data.map((c: { id: string }) => c.id)).not.toContain(coach.coachProfileId);

      // Anonymous search is unaffected: blocking is per-viewer.
      const anonymous = await api().get('/api/v1/coaches');
      expect(anonymous.body.data.map((c: { id: string }) => c.id)).toContain(coach.coachProfileId);
    });

    it('hides the blocker from the blocked user discovery too', async () => {
      const blocker = await createCoach({ sports: ['tennis'] });
      const blocked = await createCoach({ sports: ['tennis'], email: uniqueEmail('blocked-coach') });

      await api()
        .post('/api/v1/blocks')
        .set('Authorization', bearer(blocker.token))
        .send({ userId: blocked.id });

      // The block is bidirectional for discovery: the blocked coach no longer sees the blocker.
      const search = await api().get('/api/v1/coaches').set('Authorization', bearer(blocked.token));
      expect(search.body.data.map((c: { id: string }) => c.id)).not.toContain(blocker.coachProfileId);
    });
  });

  describe('reports', () => {
    it('creates a user report and lists it back to the reporter only', async () => {
      const reporter = await registerUser({ email: uniqueEmail('reporter') });
      const target = await registerUser({ email: uniqueEmail('target') });
      const auth = { Authorization: bearer(reporter.token) };

      const created = await api()
        .post('/api/v1/reports')
        .set(auth)
        .send({ targetType: 'USER', targetId: target.id, reason: 'HARASSMENT', description: 'Abusive messages' });

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ targetType: 'USER', targetUserId: target.id, status: 'PENDING' });

      const mine = await api().get('/api/v1/reports/mine').set(auth);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0].id).toBe(created.body.data.id);

      // Another user must not be able to read it.
      const other = await registerUser({ email: uniqueEmail('nosy') });
      const forbidden = await api()
        .get(`/api/v1/reports/${created.body.data.id}`)
        .set('Authorization', bearer(other.token));
      expect(forbidden.status).toBe(404);
    });

    it('rejects self-reports, duplicate pending reports and unsupported targets', async () => {
      const reporter = await registerUser();
      const target = await registerUser({ email: uniqueEmail('target') });
      const auth = { Authorization: bearer(reporter.token) };

      const self = await api()
        .post('/api/v1/reports')
        .set(auth)
        .send({ targetType: 'USER', targetId: reporter.id, reason: 'OTHER' });
      expect(self.status).toBe(400);

      const body = { targetType: 'USER', targetId: target.id, reason: 'SPAM' };
      expect((await api().post('/api/v1/reports').set(auth).send(body)).status).toBe(201);
      expect((await api().post('/api/v1/reports').set(auth).send(body)).status).toBe(409);

      const unsupported = await api()
        .post('/api/v1/reports')
        .set(auth)
        .send({ targetType: 'POST', targetId: '00000000-0000-0000-0000-000000000000', reason: 'SPAM' });
      expect(unsupported.status).toBe(400);
      expect(unsupported.body.error.details.supportedTargetTypes).toEqual(['USER']);

      const unknown = await api()
        .post('/api/v1/reports')
        .set(auth)
        .send({ targetType: 'USER', targetId: '00000000-0000-0000-0000-000000000000', reason: 'SPAM' });
      expect(unknown.status).toBe(404);
    });

    it('hides reports from other users and rejects invalid reasons', async () => {
      const reporter = await registerUser();
      const target = await registerUser({ email: uniqueEmail('target') });
      const auth = { Authorization: bearer(reporter.token) };

      const invalid = await api()
        .post('/api/v1/reports')
        .set(auth)
        .send({ targetType: 'USER', targetId: target.id, reason: 'NOT_A_REASON' });
      expect(invalid.status).toBe(400);

      const mine = await api().get('/api/v1/reports/mine').set(auth);
      expect(mine.body.data).toEqual([]);
    });
  });

  describe('admin moderation', () => {
    it('forbids non-admins from the moderation queue', async () => {
      const user = await registerUser();
      const response = await api().get('/api/v1/admin/reports').set('Authorization', bearer(user.token));
      expect(response.status).toBe(403);
    });

    it('lists pending reports and lets an admin resolve one exactly once', async () => {
      const reporter = await registerUser({ email: uniqueEmail('reporter') });
      const target = await registerUser({ email: uniqueEmail('target') });
      const admin = await registerAdmin();

      const created = await api()
        .post('/api/v1/reports')
        .set('Authorization', bearer(reporter.token))
        .send({ targetType: 'USER', targetId: target.id, reason: 'FAKE_PROFILE' });
      const reportId = created.body.data.id;

      const queue = await api()
        .get('/api/v1/admin/reports?status=PENDING')
        .set('Authorization', bearer(admin.token));
      expect(queue.status).toBe(200);
      expect(queue.body.data.map((r: { id: string }) => r.id)).toContain(reportId);
      // The admin view exposes who filed it and against whom.
      expect(queue.body.data[0].reporter).toBeTruthy();
      expect(queue.body.data[0].targetUser.id).toBe(target.id);

      const resolved = await api()
        .patch(`/api/v1/admin/reports/${reportId}/resolve`)
        .set('Authorization', bearer(admin.token))
        .send({ note: 'Confirmed fake profile' });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data.status).toBe('RESOLVED');
      expect(resolved.body.data.reviewedBy.id).toBe(admin.id);

      const again = await api()
        .patch(`/api/v1/admin/reports/${reportId}/resolve`)
        .set('Authorization', bearer(admin.token))
        .send({});
      expect(again.status).toBe(409);
    });

    it('lets an admin reject a report and keeps the reporter view free of reviewer identity', async () => {
      const reporter = await registerUser({ email: uniqueEmail('reporter') });
      const target = await registerUser({ email: uniqueEmail('target') });
      const admin = await registerAdmin();

      const created = await api()
        .post('/api/v1/reports')
        .set('Authorization', bearer(reporter.token))
        .send({ targetType: 'USER', targetId: target.id, reason: 'OTHER', description: 'Not sure' });

      const rejected = await api()
        .patch(`/api/v1/admin/reports/${created.body.data.id}/reject`)
        .set('Authorization', bearer(admin.token))
        .send({ note: 'No violation found' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.data.status).toBe('REJECTED');

      const reporterView = await api()
        .get(`/api/v1/reports/${created.body.data.id}`)
        .set('Authorization', bearer(reporter.token));
      expect(reporterView.body.data.status).toBe('REJECTED');
      expect(reporterView.body.data).not.toHaveProperty('reviewedBy');
      expect(reporterView.body.data).not.toHaveProperty('reporter');
    });
  });
});
