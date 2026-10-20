import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { RealtimeServer } from '../../src/realtime/socket.js';

// The storage provider is read once when the app module loads, so it must be set
// before anything under src/ is imported. This file therefore uses dynamic imports.
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = '.tmp/test-uploads';

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const { api, bearer, registerUser } = await import('../helpers/api.js');
const { closeDatabase, prisma, resetDatabase } = await import('../helpers/database.js');
const { createApp } = await import('../../src/app.js');
const { initRealtime } = await import('../../src/realtime/socket.js');

/**
 * Dev-only local storage provider, exercised end to end.
 *
 * Proves the upload boundary is real: a signed upload URL is issued, the bytes are
 * accepted, and the object becomes readable. Production always uses an S3-compatible
 * bucket; the local provider is refused there (see config/storage.ts).
 */
describe('Storage endpoints (local dev provider)', () => {
  let server: http.Server;
  let realtime: RealtimeServer;
  let port = 0;
  const openSockets: Socket[] = [];

  beforeAll(async () => {
    server = http.createServer(createApp());
    realtime = initRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.disconnect();
    }
    await realtime.close();
    await closeDatabase();
    rmSync(path.resolve('.tmp/test-uploads'), { recursive: true, force: true });
  });

  function connect(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
      });
      socket.once('connect', () => {
        openSockets.push(socket);
        resolve(socket);
      });
      socket.once('connect_error', reject);
    });
  }

  function join(socket: Socket, conversationId: string): Promise<unknown> {
    return new Promise((resolve) => {
      socket.emit('conversation:join', { conversationId }, resolve);
    });
  }

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

  it('stores private image uploads, authorizes downloads, and delivers one real-time message', async () => {
    const sender = await registerUser();
    const recipient = await registerUser();
    const outsider = await registerUser();
    const started = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(sender.token))
      .send({ participantId: recipient.id });
    expect(started.status).toBe(201);
    const conversationId = started.body.data.id as string;
    const socket = await connect(recipient.token);
    expect(await join(socket, conversationId)).toMatchObject({ ok: true });
    let deliveryCount = 0;
    socket.on('message:new', () => {
      deliveryCount += 1;
    });
    const delivery = new Promise<Record<string, unknown>>((resolve) => {
      socket.once('message:new', resolve);
    });

    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const clientUploadId = randomUUID();
    const sent = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('body', 'Here is the image')
      .field('clientUploadId', clientUploadId)
      .attach('file', bytes, { filename: 'training.png', contentType: 'image/png' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({
      body: 'Here is the image',
      attachment: {
        fileName: 'training.png',
        contentType: 'image/png',
        sizeBytes: bytes.length,
        downloadUrl: `/api/v1/conversations/${conversationId}/messages/${sent.body.data.id}/attachment`,
      },
    });
    expect(await delivery).toMatchObject({
      body: 'Here is the image',
      attachment: sent.body.data.attachment,
    });
    expect(deliveryCount).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);
    expect(await prisma.chatAttachment.count()).toBe(1);

    const downloadPath = sent.body.data.attachment.downloadUrl as string;
    const downloaded = await api()
      .get(downloadPath)
      .set('Authorization', bearer(recipient.token));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toContain('image/png');
    expect(Buffer.from(downloaded.body)).toEqual(bytes);
    const forbidden = await api()
      .get(downloadPath)
      .set('Authorization', bearer(outsider.token));
    expect(forbidden.status).toBe(403);

    const retry = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('body', 'Here is the image')
      .field('clientUploadId', clientUploadId)
      .attach('file', bytes, { filename: 'training.png', contentType: 'image/png' });
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(sent.body.data.id);
    expect(retry.body.data.duplicate).toBe(true);
    // The retry must not fan the same row out a second time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveryCount).toBe(1);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);

    // Metadata survives in the history, and the object is persisted on disk.
    const history = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(recipient.token));
    expect(history.status).toBe(200);
    expect(history.body.data[0]).toMatchObject({
      id: sent.body.data.id,
      attachment: sent.body.data.attachment,
    });
    const stored = await prisma.chatAttachment.findFirstOrThrow({
      select: { storageKey: true },
    });
    expect(stored.storageKey).toMatch(/^chat-attachments\//);
    expect(existsSync(path.resolve('.tmp/test-uploads', stored.storageKey))).toBe(true);
    // The private key is never reachable through the public media mount.
    const publicAttempt = await api().get(`/media/${stored.storageKey}`);
    expect(publicAttempt.status).toBe(404);
  });

  it('stores PDFs, rejects spoofed file signatures, and moderates attachment captions', async () => {
    const sender = await registerUser();
    const recipient = await registerUser();
    const outsider = await registerUser();
    const started = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(sender.token))
      .send({ participantId: recipient.id });
    const conversationId = started.body.data.id as string;
    const recipientSocket = await connect(recipient.token);
    expect(await join(recipientSocket, conversationId)).toMatchObject({ ok: true });
    const pdf = Buffer.from('%PDF-1.7\nPrivate chat document');

    const uploaded = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', pdf, { filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.attachment).toMatchObject({
      fileName: 'plan.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
    });
    const download = await api()
      .get(uploaded.body.data.attachment.downloadUrl as string)
      .set('Authorization', bearer(recipient.token));
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(download.body)).toEqual(pdf);

    const spoofed = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'not-a-pdf.pdf',
        contentType: 'application/pdf',
      });
    expect(spoofed.status).toBe(400);

    const unauthorizedUpload = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(outsider.token))
      .field('clientUploadId', randomUUID())
      .attach('file', pdf, { filename: 'private.pdf', contentType: 'application/pdf' });
    expect(unauthorizedUpload.status).toBe(403);

    let blockedBroadcast = false;
    recipientSocket.once('message:new', () => {
      blockedBroadcast = true;
    });
    const blockedCaption = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('body', 'Hada Hsabi Facebook Bilal Karbach')
      .field('clientUploadId', randomUUID())
      .attach('file', pdf, { filename: 'blocked.pdf', contentType: 'application/pdf' });
    expect(blockedCaption.status).toBe(422);
    expect(blockedCaption.body.error.details.moderation.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'FACEBOOK' })]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockedBroadcast).toBe(false);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);
  });

  it('accepts attachment-only messages and rejects invalid files', async () => {
    const sender = await registerUser();
    const recipient = await registerUser();
    const started = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(sender.token))
      .send({ participantId: recipient.id });
    const conversationId = started.body.data.id as string;

    // A caption is optional: the migration allows an empty body when an attachment exists.
    const pdf = Buffer.from('%PDF-1.7\nAttachment only');
    const attachmentOnly = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', pdf, { filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(attachmentOnly.status).toBe(201);
    expect(attachmentOnly.body.data.body).toBe('');
    expect(attachmentOnly.body.data.attachment.contentType).toBe('application/pdf');

    // Unsupported formats are rejected before anything is written.
    const gif = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', Buffer.from('GIF89a'), {
        filename: 'animation.gif',
        contentType: 'image/gif',
      });
    expect(gif.status).toBe(400);

    // The extension must match the declared MIME type.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const wrongExtension = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', png, { filename: 'photo.pdf', contentType: 'image/png' });
    expect(wrongExtension.status).toBe(400);

    // A multipart body without the file part is a validation error, not a 500.
    const missingFile = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID());
    expect(missingFile.status).toBe(400);

    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);
    expect(await prisma.chatAttachment.count()).toBe(1);
  });

  it('rejects oversized chat attachments before object storage', async () => {
    const sender = await registerUser();
    const recipient = await registerUser();
    const started = await api()
      .post('/api/v1/conversations')
      .set('Authorization', bearer(sender.token))
      .send({ participantId: recipient.id });
    const conversationId = started.body.data.id as string;
    const config = await api()
      .get('/api/v1/conversations/attachment-config')
      .set('Authorization', bearer(sender.token));
    const tooLarge = Buffer.alloc(config.body.data.maxBytes + 1, 1);

    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/attachments`)
      .set('Authorization', bearer(sender.token))
      .field('clientUploadId', randomUUID())
      .attach('file', tooLarge, { filename: 'oversized.png', contentType: 'image/png' });
    expect(response.status).toBe(413);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });
});
