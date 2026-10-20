// Storage configuration is read when application modules load, so it must be set before
// any `src/` import. Hence the dynamic imports below (same pattern as `storage-local.test.ts`).
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = '.tmp/test-verification-uploads';

const { afterAll, beforeEach, describe, expect, it } = await import('vitest');
const { api, bearer, createCoach, registerAdmin, registerUser, requestBooking, bookingWindow } = await import(
  '../helpers/api.js'
);
const { closeDatabase, resetDatabase } = await import('../helpers/database.js');

function firstDocument(documents: DocumentResponse[]): DocumentResponse {
  const [document] = documents;
  if (!document) {
    throw new Error('Expected at least one document');
  }
  return document;
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const UPLOADS_DIR = '.tmp/test-verification-uploads';

interface DocumentResponse {
  id: string;
  type: string;
  fileName: string | null;
  contentType: string;
  sizeBytes: number | null;
  isCurrent: boolean;
  confirmed: boolean;
}

interface CoachVerification {
  status: string;
  submittedAt: string | null;
  requiredDocumentTypes: string[];
  missingRequirements: string[];
  canEditDocuments: boolean;
  canSubmit: boolean;
  documents: DocumentResponse[];
  adminFeedback: { note: string | null; decidedAt: string | null };
  history: { type: string; toStatus: string | null; note: string | null }[];
}

interface AdminVerification {
  id: string | null;
  coachProfileId: string;
  status: string;
  documentCount: number;
  coach: { id: string; displayName: string; email: string | null } | null;
  isPublished: boolean;
  history: { type: string; actor: { displayName: string } | null }[];
  documents: DocumentResponse[];
}

interface UploadTarget {
  key: string;
  uploadUrl: string;
  maxBytes: number;
}

/** Create the upload target, push the bytes to storage, then confirm the document. */
async function uploadDocument(
  token: string,
  options: {
    type?: string;
    contentType?: string;
    fileName?: string;
    bytes?: Buffer;
  } = {},
): Promise<{ documentId: string; storageKey: string; confirmStatus: number; body: unknown }> {
  const contentType = options.contentType ?? 'application/pdf';

  const created = await api()
    .post('/api/v1/coaches/me/verification/documents')
    .set('Authorization', bearer(token))
    .send({
      type: options.type ?? 'DIPLOMA',
      contentType,
      fileName: options.fileName ?? 'diploma.pdf',
    });

  if (created.status !== 201) {
    throw new Error(`upload target creation failed (${created.status}): ${JSON.stringify(created.body)}`);
  }

  const upload = created.body.data.upload as UploadTarget;
  const documentId = created.body.data.documentId as string;

  const url = new URL(upload.uploadUrl);
  const pushed = await api()
    .put(`${url.pathname}${url.search}`)
    .set('Content-Type', contentType)
    .send(options.bytes ?? PDF_BYTES);

  if (pushed.status !== 200) {
    throw new Error(`local upload failed (${pushed.status}): ${JSON.stringify(pushed.body)}`);
  }

  const confirmed = await api()
    .post(`/api/v1/coaches/me/verification/documents/${documentId}/confirm`)
    .set('Authorization', bearer(token));

  return { documentId, storageKey: upload.key, confirmStatus: confirmed.status, body: confirmed.body };
}

async function getMyVerification(token: string): Promise<CoachVerification> {
  const response = await api().get('/api/v1/coaches/me/verification').set('Authorization', bearer(token));
  expect(response.status).toBe(200);
  return response.body.data as CoachVerification;
}

async function submit(token: string) {
  return api().post('/api/v1/coaches/me/verification/submit').set('Authorization', bearer(token));
}

/** Upload + submit, returning the admin-visible application id. */
async function submitApplication(coachToken: string, adminToken: string): Promise<string> {
  const uploaded = await uploadDocument(coachToken);
  expect(uploaded.confirmStatus).toBe(200);

  const submitted = await submit(coachToken);
  expect(submitted.status).toBe(200);
  expect((submitted.body.data as CoachVerification).status).toBe('PENDING');

  const list = await api().get('/api/v1/admin/verifications').set('Authorization', bearer(adminToken));
  expect(list.status).toBe(200);
  const id = list.body.data[0]?.id as string | undefined;
  if (!id) {
    throw new Error(`No verification application found: ${JSON.stringify(list.body)}`);
  }
  return id;
}

describe('Coach verification', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(UPLOADS_DIR, { recursive: true, force: true });
    await closeDatabase();
  });

  it('leaves CLIENT registration untouched', async () => {
    const client = await registerUser();
    expect(client.role).toBe('CLIENT');

    // The public coach catalogue keeps working for anonymous visitors.
    const search = await api().get('/api/v1/coaches');
    expect(search.status).toBe(200);
  });

  it('starts as NOT_SUBMITTED and refuses to submit without a document', async () => {
    const coach = await createCoach({ published: true, approved: false });

    const initial = await getMyVerification(coach.token);
    expect(initial.status).toBe('NOT_SUBMITTED');
    expect(initial.canEditDocuments).toBe(true);
    expect(initial.requiredDocumentTypes).toEqual(expect.arrayContaining(['DIPLOMA']));
    expect(initial.missingRequirements.length).toBeGreaterThan(0);

    const blocked = await submit(coach.token);
    expect(blocked.status).toBe(400);
    expect(String(blocked.body.error.message)).toContain('document');
  });

  it('protects verification reads and returns 404 for a coach without a profile', async () => {
    const client = await registerUser();
    const coach = await registerUser({ role: 'COACH' });

    expect((await api().get('/api/v1/coaches/me/verification')).status).toBe(401);
    expect(
      (await api()
        .get('/api/v1/coaches/me/verification')
        .set('Authorization', bearer(client.token))).status,
    ).toBe(403);
    expect(
      (await api()
        .get('/api/v1/coaches/me/verification')
        .set('Authorization', bearer(coach.token))).status,
    ).toBe(404);
  });

  it('requires COACH authorization and validates the document type', async () => {
    const client = await registerUser();
    const coach = await createCoach({ published: true, approved: false });

    expect((await api().post('/api/v1/coaches/me/verification/documents').send({ type: 'DIPLOMA', contentType: 'application/pdf' })).status).toBe(401);
    expect(
      (
        await api()
          .post('/api/v1/coaches/me/verification/documents')
          .set('Authorization', bearer(client.token))
          .send({ type: 'DIPLOMA', contentType: 'application/pdf' })
      ).status,
    ).toBe(403);

    const unsupported = await api()
      .post('/api/v1/coaches/me/verification/documents')
      .set('Authorization', bearer(coach.token))
      .send({ type: 'DIPLOMA', contentType: 'application/zip' });
    expect(unsupported.status).toBe(400);
  });

  it('rejects a document whose bytes contradict the declared content type', async () => {
    const coach = await createCoach({ published: true, approved: false });

    // A PNG uploaded as a PDF must be refused, and the row discarded.
    const result = await uploadDocument(coach.token, { contentType: 'application/pdf', bytes: PNG_BYTES });
    expect(result.confirmStatus).toBe(400);

    const verification = await getMyVerification(coach.token);
    expect(verification.documents).toHaveLength(0);
  });

  it('accepts private documents larger than the public-media upload limit', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const bytes = Buffer.concat([PDF_BYTES, Buffer.alloc(6 * 1024 * 1024)]);

    const uploaded = await uploadDocument(coach.token, { bytes, fileName: 'large-diploma.pdf' });

    expect(uploaded.confirmStatus).toBe(200);
    const verification = await getMyVerification(coach.token);
    expect(firstDocument(verification.documents)).toMatchObject({
      fileName: 'large-diploma.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      confirmed: true,
    });
  });

  it('persists an uploaded certificate image and returns it on a fresh verification read', async () => {
    const coach = await createCoach({ published: true, approved: false });

    const uploaded = await uploadDocument(coach.token, {
      type: 'CERTIFICATION',
      contentType: 'image/png',
      fileName: 'certificate.png',
      bytes: PNG_BYTES,
    });

    expect(uploaded.confirmStatus).toBe(200);
    const refreshed = await getMyVerification(coach.token);
    expect(firstDocument(refreshed.documents)).toMatchObject({
      type: 'CERTIFICATION',
      fileName: 'certificate.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
      confirmed: true,
    });
  });

  it('rejects private documents larger than the configured document limit', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const created = await api()
      .post('/api/v1/coaches/me/verification/documents')
      .set('Authorization', bearer(coach.token))
      .send({ type: 'DIPLOMA', contentType: 'application/pdf' });
    expect(created.status).toBe(201);

    const upload = created.body.data.upload as UploadTarget;
    const url = new URL(upload.uploadUrl);
    const oversized = Buffer.alloc(upload.maxBytes + 1, 0x20);
    oversized.write('%PDF-1.4');

    const response = await api()
      .put(`${url.pathname}${url.search}`)
      .set('Content-Type', 'application/pdf')
      .send(oversized);

    expect(response.status).toBe(413);
  });

  it("does not let one coach touch another coach's documents", async () => {
    const owner = await createCoach({ published: true, approved: false });
    const attacker = await createCoach({ published: true, approved: false });

    const created = await api()
      .post('/api/v1/coaches/me/verification/documents')
      .set('Authorization', bearer(owner.token))
      .send({ type: 'DIPLOMA', contentType: 'application/pdf', fileName: 'owner.pdf' });

    const documentId = created.body.data.documentId as string;

    const confirm = await api()
      .post(`/api/v1/coaches/me/verification/documents/${documentId}/confirm`)
      .set('Authorization', bearer(attacker.token));
    expect(confirm.status).toBe(404);

    const remove = await api()
      .delete(`/api/v1/coaches/me/verification/documents/${documentId}`)
      .set('Authorization', bearer(attacker.token));
    expect(remove.status).toBe(404);
  });

  it('runs the whole lifecycle: upload, submit, admin review, approval, discovery', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();

    // Before approval the coach is invisible to clients.
    const beforeSearch = await api().get('/api/v1/coaches');
    expect(beforeSearch.body.data.map((row: { id: string }) => row.id)).not.toContain(coach.coachProfileId);
    expect((await api().get(`/api/v1/coaches/${coach.coachProfileId}`)).status).toBe(404);

    const uploaded = await uploadDocument(coach.token);
    expect(uploaded.confirmStatus).toBe(200);

    const publicAttempt = await api().get(`/media/${uploaded.storageKey}`);
    expect(publicAttempt.status).toBe(404);

    const submitted = await submit(coach.token);
    expect(submitted.status).toBe(200);
    expect((submitted.body.data as CoachVerification).status).toBe('PENDING');

    const list = await api().get('/api/v1/admin/verifications').set('Authorization', bearer(admin.token));
    expect(list.status).toBe(200);
    const verificationId = list.body.data[0]?.id as string | undefined;
    if (!verificationId) {
      throw new Error(`No verification application found: ${JSON.stringify(list.body)}`);
    }

    const detail = await api().get(`/api/v1/admin/verifications/${verificationId}`).set('Authorization', bearer(admin.token));
    expect(detail.status).toBe(200);
    const application = detail.body.data as AdminVerification;
    expect(application.status).toBe('PENDING');
    expect(application.documents).toHaveLength(1);
    expect(firstDocument(application.documents).confirmed).toBe(true);
    expect(application.coach?.displayName).toBe('Test Coach');

    // Admins stream the private document through the API - no public URL exists.
    const documentPath = `/api/v1/admin/verifications/documents/${firstDocument(application.documents).id}/file`;
    expect((await api().get(documentPath)).status).toBe(401);
    expect(
      (await api().get(documentPath).set('Authorization', bearer(coach.token))).status,
    ).toBe(403);
    const download = await api()
      .get(documentPath)
      .set('Authorization', bearer(admin.token));
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['cache-control']).toContain('no-store');
    expect((download.body as Buffer).byteLength).toBe(PDF_BYTES.byteLength);

    const approved = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
      .set('Authorization', bearer(admin.token))
      .send({ note: 'Diploma matches the profile.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    // Now the coach is discoverable and bookable.
    const afterSearch = await api().get('/api/v1/coaches');
    expect(afterSearch.body.data.map((row: { id: string }) => row.id)).toContain(coach.coachProfileId);

    const client = await registerUser();
    const booking = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10, 1));
    expect(booking.status).toBe(201);
  });

  it('keeps unverified coaches out of search, detail and new bookings', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const client = await registerUser();

    await uploadDocument(coach.token);

    const search = await api().get('/api/v1/coaches');
    expect(search.body.data.map((row: { id: string }) => row.id)).not.toContain(coach.coachProfileId);
    expect((await api().get(`/api/v1/coaches/${coach.coachProfileId}`)).status).toBe(404);

    const booking = await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10, 1));
    expect(booking.status).toBe(404);

    // Suggestions never surface an unverified coach either.
    const suggestions = await api().get('/api/v1/matches/suggestions').set('Authorization', bearer(client.token));
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.data.map((row: { id: string }) => row.id)).not.toContain(coach.coachProfileId);

    // Sport counts only include verified coaches.
    const sports = await api().get('/api/v1/sports');
    const fitness = (sports.body.data as { slug: string; coachCount: number }[]).find((row) => row.slug === 'fitness');
    expect(fitness?.coachCount).toBe(0);
  });

  it('does not publish a profile just because the verification was approved', async () => {
    // Approval is a trust decision; the publication rules (coordinates + sports) still apply.
    const coach = await createCoach({ published: false, approved: true });

    expect((await api().get(`/api/v1/coaches/${coach.coachProfileId}`)).status).toBe(404);
    const search = await api().get('/api/v1/coaches');
    expect(search.body.data.map((row: { id: string }) => row.id)).not.toContain(coach.coachProfileId);
  });

  it('refuses review actions to non-admins and repeated decisions', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();
    const client = await registerUser();

    const verificationId = await submitApplication(coach.token, admin.token);

    expect((await api().get('/api/v1/admin/verifications').set('Authorization', bearer(client.token))).status).toBe(403);
    expect(
      (
        await api()
          .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
          .set('Authorization', bearer(coach.token))
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .patch(`/api/v1/admin/verifications/${verificationId}/in-review`)
          .set('Authorization', bearer(admin.token))
      ).status,
    ).toBe(200);

    const first = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
      .set('Authorization', bearer(admin.token))
      .send({});
    expect(first.status).toBe(200);

    const second = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
      .set('Authorization', bearer(admin.token))
      .send({});
    expect(second.status).toBe(409);
  });

  it('rejects with a reason, requires the reason, and blocks bookings afterwards', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();
    const client = await registerUser();

    const verificationId = await submitApplication(coach.token, admin.token);

    const withoutReason = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/reject`)
      .set('Authorization', bearer(admin.token))
      .send({});
    expect(withoutReason.status).toBe(400);

    const rejected = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/reject`)
      .set('Authorization', bearer(admin.token))
      .send({ note: 'The uploaded certificate is not a coaching qualification.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');

    // The coach sees the decision and the feedback, and can correct it.
    const mine = await getMyVerification(coach.token);
    expect(mine.status).toBe('REJECTED');
    expect(mine.adminFeedback.note).toContain('not a coaching qualification');
    expect(mine.canEditDocuments).toBe(true);
    expect(mine.canSubmit).toBe(true);

    // No new bookings while rejected.
    expect((await requestBooking(client.token, coach.coachProfileId, bookingWindow(2, 10, 1))).status).toBe(404);
  });

  it('supports NEEDS_INFO, document replacement and resubmission', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();

    const verificationId = await submitApplication(coach.token, admin.token);

    const requested = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/request-info`)
      .set('Authorization', bearer(admin.token))
      .send({ note: 'Please upload the back side of the certificate as well.' });
    expect(requested.status).toBe(200);
    expect(requested.body.data.status).toBe('NEEDS_INFO');

    const afterRequest = await getMyVerification(coach.token);
    expect(afterRequest.status).toBe('NEEDS_INFO');
    expect(afterRequest.adminFeedback.note).toContain('back side');
    expect(afterRequest.canEditDocuments).toBe(true);

    // The coach replaces the document and resubmits.
    const replaced = await api()
      .delete(`/api/v1/coaches/me/verification/documents/${firstDocument(afterRequest.documents).id}`)
      .set('Authorization', bearer(coach.token));
    expect(replaced.status).toBe(200);

    const reuploaded = await uploadDocument(coach.token, { fileName: 'diploma-corrected.pdf' });
    expect(reuploaded.confirmStatus).toBe(200);

    const resubmitted = await submit(coach.token);
    expect(resubmitted.status).toBe(200);
    const body = resubmitted.body.data as CoachVerification;
    expect(body.status).toBe('PENDING');
    expect(body.adminFeedback.note).toBeNull();
    expect(body.history.map((entry) => entry.type)).toContain('RESUBMITTED');
  });

  it('locks documents while the application is under review', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();

    const verificationId = await submitApplication(coach.token, admin.token);
    const application = (await api().get(`/api/v1/admin/verifications/${verificationId}`).set('Authorization', bearer(admin.token)))
      .body.data as AdminVerification;

    const remove = await api()
      .delete(`/api/v1/coaches/me/verification/documents/${firstDocument(application.documents).id}`)
      .set('Authorization', bearer(coach.token));
    expect(remove.status).toBe(409);

    const addMore = await api()
      .post('/api/v1/coaches/me/verification/documents')
      .set('Authorization', bearer(coach.token))
      .send({ type: 'CERTIFICATION', contentType: 'image/png' });
    expect(addMore.status).toBe(409);
  });

  it('records an auditable history of status changes', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();

    const verificationId = await submitApplication(coach.token, admin.token);
    await api().patch(`/api/v1/admin/verifications/${verificationId}/in-review`).set('Authorization', bearer(admin.token));
    await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
      .set('Authorization', bearer(admin.token))
      .send({ note: 'Looks good.' });

    const application = (
      await api().get(`/api/v1/admin/verifications/${verificationId}`).set('Authorization', bearer(admin.token))
    ).body.data as AdminVerification;

    const types = application.history.map((entry) => entry.type);
    expect(types).toEqual(expect.arrayContaining(['SUBMITTED', 'DOCUMENT_UPLOADED', 'MARKED_IN_REVIEW', 'APPROVED']));
    expect(application.history.every((entry) => entry.actor !== undefined)).toBe(true);
  });

  it('lets an administrator deliberately verify a coach that predates verification', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();

    const queue = await api()
      .get('/api/v1/admin/verifications/unverified-coaches')
      .set('Authorization', bearer(admin.token));
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((row: { coachProfileId: string }) => row.coachProfileId)).toContain(
      coach.coachProfileId,
    );
    expect(queue.body.data[0].status).toBe('NOT_SUBMITTED');

    const grandfathered = await api()
      .post('/api/v1/admin/verifications/grandfather')
      .set('Authorization', bearer(admin.token))
      .send({ coachProfileId: coach.coachProfileId, note: 'Existing coach reviewed offline in 2026.' });
    expect(grandfathered.status).toBe(200);
    expect(grandfathered.body.data.status).toBe('APPROVED');

    const search = await api().get('/api/v1/coaches');
    expect(search.body.data.map((row: { id: string }) => row.id)).toContain(coach.coachProfileId);

    const again = await api()
      .post('/api/v1/admin/verifications/grandfather')
      .set('Authorization', bearer(admin.token))
      .send({ coachProfileId: coach.coachProfileId, note: 'Duplicate attempt' });
    expect(again.status).toBe(409);
  });

  it('keeps document review manual and no longer exposes the analysis endpoint', async () => {
    const coach = await createCoach({ published: true, approved: false });
    const admin = await registerAdmin();
    const verificationId = await submitApplication(coach.token, admin.token);

    const detail = await api()
      .get(`/api/v1/admin/verifications/${verificationId}`)
      .set('Authorization', bearer(admin.token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.documents).toHaveLength(1);
    expect(detail.body.data.documents[0]).toMatchObject({ type: 'DIPLOMA', confirmed: true });
    expect(detail.body.data).not.toHaveProperty('aiAnalysis');
    expect(detail.body.data).not.toHaveProperty('aiStatus');
    expect(await getMyVerification(coach.token)).not.toHaveProperty('aiAnalysis');

    const removedEndpoint = await api()
      .post(`/api/v1/admin/verifications/${verificationId}/analyze`)
      .set('Authorization', bearer(admin.token))
      .send({});
    expect(removedEndpoint.status).toBe(404);

    const approved = await api()
      .patch(`/api/v1/admin/verifications/${verificationId}/approve`)
      .set('Authorization', bearer(admin.token))
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
  });
});
