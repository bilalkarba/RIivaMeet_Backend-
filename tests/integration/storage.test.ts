import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { api, bearer, registerUser } from '../helpers/api.js';
import { closeDatabase, resetDatabase } from '../helpers/database.js';

/**
 * Storage HTTP surface with the default (unconfigured) provider.
 *
 * The whole point of this state is that clients can *tell* the difference between
 * "uploads disabled" and a real failure, so the tests pin the exact shape of the 503.
 */
describe('Storage endpoints (unconfigured)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('requires authentication', async () => {
    expect((await api().get('/api/v1/storage/status')).status).toBe(401);
    expect((await api().post('/api/v1/storage/uploads').send({ contentType: 'image/png' })).status).toBe(401);
  });

  it('reports that object storage is not configured', async () => {
    const user = await registerUser();
    const response = await api().get('/api/v1/storage/status').set('Authorization', bearer(user.token));

    expect(response.status).toBe(200);
    expect(response.body.data.configured).toBe(false);
    expect(response.body.data.provider).toBe('none');
    expect(response.body.data.requiredEnvVars).toContain('STORAGE_PROVIDER=s3');
  });

  it('returns 503 with requiredEnvVars instead of a fake upload URL', async () => {
    const user = await registerUser();
    const response = await api()
      .post('/api/v1/storage/uploads')
      .set('Authorization', bearer(user.token))
      .send({ kind: 'avatar', contentType: 'image/png' });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.details.requiredEnvVars.length).toBeGreaterThan(0);
    expect(response.body.data).toBeUndefined();
  });

  it('rejects an unsupported content type with 400', async () => {
    const user = await registerUser();
    const response = await api()
      .post('/api/v1/storage/uploads')
      .set('Authorization', bearer(user.token))
      .send({ contentType: 'application/x-msdownload' });

    expect(response.status).toBe(400);
  });
});
