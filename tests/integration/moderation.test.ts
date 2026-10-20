import { beforeEach, describe, expect, it } from "vitest";

import {
  api,
  bearer,
  registerAdmin,
  registerUser,
  uniqueEmail,
} from "../helpers/api.js";
import { prisma, resetDatabase } from "../helpers/database.js";

describe("Message moderation", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function conversationBetween(
    firstToken: string,
    secondId: string,
  ): Promise<string> {
    const response = await api()
      .post("/api/v1/conversations")
      .set("Authorization", bearer(firstToken))
      .send({ participantId: secondId });

    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  it("exposes the active policy to authenticated clients only", async () => {
    const user = await registerUser({ email: uniqueEmail("mod-policy") });

    expect(
      (await api().get("/api/v1/conversations/moderation-policy")).status,
    ).toBe(401);

    const response = await api()
      .get("/api/v1/conversations/moderation-policy")
      .set("Authorization", bearer(user.token));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ enabled: true, policy: "block" });
  });

  it("allows ordinary coaching messages and reports an ALLOW outcome", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-a") });
    const b = await registerUser({ email: uniqueEmail("mod-b") });
    const conversationId = await conversationBetween(a.token, b.id);

    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(a.token))
      .send({
        body: "Great session today. Do 3 sets of 12 reps and rest 90 seconds.",
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      body: "Great session today. Do 3 sets of 12 reps and rest 90 seconds.",
      moderation: { action: "ALLOW", policy: "block", matches: [] },
    });
  });

  it("rejects a prohibited phone number before persistence", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-a") });
    const b = await registerUser({ email: uniqueEmail("mod-b") });
    const conversationId = await conversationBetween(a.token, b.id);
    const body = "Call me on +49 176 1234567 to arrange the session.";

    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(a.token))
      .send({ body });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "UNPROCESSABLE_ENTITY",
      details: {
        moderation: {
          policy: "block",
          matches: expect.arrayContaining([
            expect.objectContaining({ kind: "PHONE" }),
          ]),
        },
      },
    });
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
    const history = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(b.token));
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual([]);
  });

  it("rejects social links without revealing matched details or persisting the message", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-a") });
    const b = await registerUser({ email: uniqueEmail("mod-b") });
    const conversationId = await conversationBetween(a.token, b.id);

    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(a.token))
      .send({ body: "Find me on instagram[.]com/private.coach" });

    expect(response.status).toBe(422);
    expect(response.body.error.details.moderation.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "INSTAGRAM" })]),
    );
    expect(
      JSON.stringify(response.body.error.details.moderation),
    ).not.toContain("private.coach");
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("rejects a disguised Facebook account reference before persistence", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-facebook-a") });
    const b = await registerUser({ email: uniqueEmail("mod-facebook-b") });
    const conversationId = await conversationBetween(a.token, b.id);

    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(a.token))
      .send({ body: "Hada Hsabi Facebook Bilal Karbach" });

    expect(response.status).toBe(422);
    expect(response.body.error.details.moderation.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "FACEBOOK" })]),
    );
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("rejects lowercase, French, Arabic and obfuscated Facebook variants before persistence", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-fb-variants-a") });
    const b = await registerUser({ email: uniqueEmail("mod-fb-variants-b") });
    const conversationId = await conversationBetween(a.token, b.id);

    const variants = [
      "facebook bilal karbach",
      "my facebook is bilal karbach",
      "facebook account bilal",
      "fb: bilalkarbach",
      "hada hsabi facbook bilal karbach",
      "face book bilal karbach",
      "f a c e b o o k Bilal Karbach",
      "faysbook bilal karbach",
      "facebook[.]com/bilal",
      "مون كومبت فيسبوك بلال كرباش",
      "حسابي على فيسبوك بلال كرباش",
      "فيسبوك بلال كرباش",
    ];

    for (const body of variants) {
      const response = await api()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set("Authorization", bearer(a.token))
        .send({ body });

      expect(response.status, body).toBe(422);
      expect(response.body.error.details.moderation.matches, body).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "FACEBOOK" })]),
      );
    }

    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("allows legitimate social-media discussion in English, French and Arabic", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-discussion-a") });
    const b = await registerUser({ email: uniqueEmail("mod-discussion-b") });
    const conversationId = await conversationBetween(a.token, b.id);

    const messages = [
      "Our Facebook page has the schedule for next week.",
      "We discussed Instagram marketing during the coaching course.",
      "Facebook Messenger is down today.",
      "Facebook est utile pour le club.",
      "Nous avons parlé de Facebook pendant la formation.",
      // Arabic ordinary text is covered by the unit suite: the embedded test cluster on
      // Windows may be initialised with a non-UTF8 encoding, which cannot store it.
    ];

    for (const body of messages) {
      const response = await api()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set("Authorization", bearer(a.token))
        .send({ body });

      expect(
        response.status,
        `${body} -> ${JSON.stringify(response.body)}`,
      ).toBe(201);
      expect(response.body.data.moderation).toMatchObject({
        action: "ALLOW",
        policy: "block",
        matches: [],
      });
    }

    expect(await prisma.message.count({ where: { conversationId } })).toBe(
      messages.length,
    );
  });

  it("lists and reviews flags for administrators only", async () => {
    const a = await registerUser({ email: uniqueEmail("mod-a") });
    const b = await registerUser({ email: uniqueEmail("mod-b") });
    const admin = await registerAdmin();
    const conversationId = await conversationBetween(a.token, b.id);

    const posted = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(a.token))
      .send({ body: "Let us keep this inside RivaMeet." });
    expect(posted.status).toBe(201);

    const messageId = posted.body.data.id as string;
    const flag = await prisma.messageModerationFlag.create({
      data: {
        messageId,
        conversationId,
        senderId: a.id,
        policy: "flag",
        matches: [{ kind: "PHONE", label: "Phone number" }] as never,
      },
    });

    expect(
      (
        await api()
          .get("/api/v1/admin/message-flags")
          .set("Authorization", bearer(a.token))
      ).status,
    ).toBe(403);

    const queue = await api()
      .get("/api/v1/admin/message-flags?reviewed=false")
      .set("Authorization", bearer(admin.token));
    expect(queue.status).toBe(200);
    expect(queue.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: flag.id,
          messageId,
          policy: "flag",
          reviewedAt: null,
        }),
      ]),
    );

    const reviewed = await api()
      .patch(`/api/v1/admin/message-flags/${flag.id}/review`)
      .set("Authorization", bearer(admin.token))
      .send({ note: "Reviewed: new account, warning only." });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.reviewedAt).toEqual(expect.any(String));
    expect(reviewed.body.data.reviewNote).toBe(
      "Reviewed: new account, warning only.",
    );

    const repeated = await api()
      .patch(`/api/v1/admin/message-flags/${flag.id}/review`)
      .set("Authorization", bearer(admin.token))
      .send({});
    expect(repeated.status).toBe(409);
  });
});
