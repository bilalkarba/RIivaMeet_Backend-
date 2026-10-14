import { rmSync } from 'node:fs';
import path from 'node:path';

// The storage provider is read once when the app module loads, so it must be set
// before anything under src/ is imported. This file therefore uses dynamic imports.
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = '.tmp/test-uploads';

const { afterAll, beforeEach, describe, expect, it } = await import('vitest');
const { api, bearer, registerUser } = await import('../helpers/api.js');
const { closeDatabase, resetDatabase } = await import('../helpers/database.js');

/**
 * Dev-only local storage provider, exercised end to end.
 *
 * Proves the upload boundary is real: a signed upload URL is issued, the bytes are
 * accepted, and the object becomes readable. Production always uses an S3-compatible
 * bucket; the local provider is refused there (see config/storage.ts).
 */
describe('Storage endpoints (local dev provider)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
    rmSync(path.resolve('.tmp/test-uploads'), { recursive: true, force: true });
  });

  it('reports the local provider as configured', async () => {
    const user = await registerUser();
    const response = await api().get('/api/v1/storage/status').set('Authorization', bearer(user.token));

    expect(response.status).toBe(200);
    expect(response.body.data.configured).toBe(true);
    expect(response.body.data.provider).toBe('local');
  });

  it('issues a signed upload URL and stores the uploaded avatar', async () => {
    const user = await registerUser();
    const auth = { Authorization: bearer(user.token) };

    const created = await api()
      .post('/api/v1/storage/uploads')
      .set(auth)
      .send({ kind: 'avatar', contentType: 'image/png' });

    expect(created.status).toBe(201);
    const { uploadUrl, publicUrl, maxBytes } = created.body.data as {
      uploadUrl: string;
      publicUrl: string;
      maxBytes: number;
    };
    expect(maxBytes).toBeGreaterThan(0);

    const url = new URL(uploadUrl);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await api()
      .put(`${url.pathname}${url.search}`)
      .set('Content-Type', 'image/png')
      .send(bytes);

    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data.size).toBe(bytes.byteLength);

    // The object is served back through the dev media route.
    const fetched = await api().get(new URL(publicUrl).pathname);
    expect(fetched.status).toBe(200);
    expect(fetched.body.length ?? fetched.body.byteLength).toBe(bytes.byteLength);

    // The avatar URL can then be persisted on the profile.
    const profile = await api().patch('/api/v1/profile/me').set(auth).send({ avatarUrl: publicUrl });
    expect(profile.status).toBe(200);
    expect(profile.body.data.avatarUrl).toBe(publicUrl);
  });

  it('rejects an upload with a tampered token', async () => {
    const user = await registerUser();
    const created = await api()
      .post('/api/v1/storage/uploads')
      .set('Authorization', bearer(user.token))
      .send({ kind: 'avatar', contentType: 'image/png' });

    const url = new URL(created.body.data.uploadUrl as string);
    url.searchParams.set('token', 'deadbeefdeadbeefdeadbeefdeadbeef');

    const response = await api().put(`${url.pathname}${url.search}`).set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(response.status).toBe(403);
  });

  it('rejects an upload that exceeds the configured size limit', async () => {
    const user = await registerUser();
    const created = await api()
      .post('/api/v1/storage/uploads')
      .set('Authorization', bearer(user.token))
      .send({ kind: 'avatar', contentType: 'image/png' });

    const url = new URL(created.body.data.uploadUrl as string);
    const oversized = Buffer.alloc(6 * 1024 * 1024, 1);

    const response = await api().put(`${url.pathname}${url.search}`).set('Content-Type', 'image/png').send(oversized);
    expect([413, 400]).toContain(response.status);
  });
});
