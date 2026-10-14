import { describe, expect, it } from 'vitest';

import { resolveStorageConfig } from '../../src/config/storage.js';
import {
  createUploadTarget,
  getStorageStatus,
  signLocalUploadToken,
  verifyLocalUploadToken,
} from '../../src/services/storage.service.js';
import { ApiError } from '../../src/utils/errors.js';

/**
 * Storage boundary unit tests.
 *
 * The test environment runs with `STORAGE_PROVIDER=none`, so these assertions cover the
 * documented "configuration required" state and the request validation that precedes it.
 * Object delivery itself requires real credentials and is not simulated here.
 */
describe('Storage provider abstraction', () => {
  it('reports an unavailable, documented state when no provider is configured', () => {
    const status = getStorageStatus();
    expect(status.configured).toBe(false);
    expect(status.provider).toBe('none');
    expect(status.requiredEnvVars.length).toBeGreaterThan(0);
    expect(status.reason).toContain('storage');
  });

  it('rejects an unsupported content type with 400 before checking availability', async () => {
    await expect(
      createUploadTarget({ kind: 'avatar', ownerUserId: '00000000-0000-0000-0000-000000000000', contentType: 'text/plain' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers 503 with the required env vars when storage is not configured', async () => {
    const error = await createUploadTarget({
      kind: 'avatar',
      ownerUserId: '00000000-0000-0000-0000-000000000000',
      contentType: 'image/png',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(503);
    expect((error as ApiError).details).toMatchObject({ requiredEnvVars: expect.any(Array) });
  });

  it('does not treat an incomplete S3 configuration as available', () => {
    const config = resolveStorageConfig();
    expect(config.unavailableReason).toBeTruthy();
  });
});

describe('Local dev upload tokens', () => {
  it('round-trips a valid token', () => {
    const key = 'avatars/user/abc.png';
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = signLocalUploadToken(key, expiresAt);
    expect(verifyLocalUploadToken(key, expiresAt, token)).toBe(true);
  });

  it('rejects a token for a different key', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const token = signLocalUploadToken('avatars/user/abc.png', expiresAt);
    expect(verifyLocalUploadToken('avatars/user/other.png', expiresAt, token)).toBe(false);
  });

  it('rejects an expired token', () => {
    const key = 'avatars/user/abc.png';
    const expiresAt = Math.floor(Date.now() / 1000) - 1;
    const token = signLocalUploadToken(key, expiresAt);
    expect(verifyLocalUploadToken(key, expiresAt, token)).toBe(false);
  });

  it('rejects a malformed token', () => {
    const key = 'avatars/user/abc.png';
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    expect(verifyLocalUploadToken(key, expiresAt, 'not-a-real-token')).toBe(false);
  });
});
