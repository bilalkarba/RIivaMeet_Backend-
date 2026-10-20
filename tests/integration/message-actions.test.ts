import { beforeEach, describe, expect, it } from "vitest";

import { api, bearer, registerUser, uniqueEmail } from "../helpers/api.js";
import { prisma, resetDatabase } from "../helpers/database.js";

describe("Message edit and delete", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function createConversation(): Promise<{
    sender: Awaited<ReturnType<typeof registerUser>>;
    recipient: Awaited<ReturnType<typeof registerUser>>;
    conversationId: string;
  }> {
    const sender = await registerUser({ email: uniqueEmail("message-author") });
    const recipient = await registerUser({
      email: uniqueEmail("message-recipient"),
    });
    const response = await api()
      .post("/api/v1/conversations")
      .set("Authorization", bearer(sender.token))
      .send({ participantId: recipient.id });

    expect(response.status).toBe(201);
    return {
      sender,
      recipient,
      conversationId: response.body.data.id as string,
    };
  }

  async function sendInitialMessage(
    senderToken: string,
    conversationId: string,
    body = "Original message",
  ): Promise<{ id: string; senderId: string; createdAt: string; revision: number }> {
    const response = await api()
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(senderToken))
      .send({ body });

    expect(response.status).toBe(201);
    return {
      id: response.body.data.id as string,
      senderId: response.body.data.senderId as string,
      createdAt: response.body.data.createdAt as string,
      revision: response.body.data.revision as number,
    };
  }

  it("allows the sender to edit without changing message identity or creation time", async () => {
    const { sender, recipient, conversationId } = await createConversation();
    const original = await sendInitialMessage(sender.token, conversationId);

    const edited = await api()
      .patch(`/api/v1/conversations/${conversationId}/messages/${original.id}`)
      .set("Authorization", bearer(sender.token))
      .send({ body: "Updated coaching details", revision: original.revision });

    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      id: original.id,
      conversationId,
      senderId: original.senderId,
      body: "Updated coaching details",
      createdAt: original.createdAt,
      revision: original.revision + 1,
      moderation: { action: "ALLOW" },
    });
    expect(edited.body.data.editedAt).toEqual(expect.any(String));
    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);

    const history = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(recipient.token));
    expect(history.body.data).toMatchObject([
      {
        id: original.id,
        body: "Updated coaching details",
        editedAt: edited.body.data.editedAt,
        revision: original.revision + 1,
      },
    ]);

    const staleEdit = await api()
      .patch(`/api/v1/conversations/${conversationId}/messages/${original.id}`)
      .set("Authorization", bearer(sender.token))
      .send({ body: "Stale edit must not overwrite", revision: original.revision });
    expect(staleEdit.status).toBe(409);
  });

  it("rejects recipient edits/deletes and lets the sender hard-delete the message", async () => {
    const { sender, recipient, conversationId } = await createConversation();
    const original = await sendInitialMessage(sender.token, conversationId);
    const url = `/api/v1/conversations/${conversationId}/messages/${original.id}`;

    expect(
      (await api().patch(url).send({ body: "Anonymous edit", revision: original.revision })).status,
    ).toBe(401);
    expect(
      (
        await api()
          .patch(url)
          .set("Authorization", bearer(recipient.token))
          .send({ body: "Anonymous edit", revision: original.revision })
      ).status,
    ).toBe(403);
    expect(
      (await api().delete(url).set("Authorization", bearer(recipient.token)))
        .status,
    ).toBe(403);
    expect(await prisma.message.count({ where: { id: original.id } })).toBe(1);

    const deleted = await api()
      .delete(url)
      .set("Authorization", bearer(sender.token));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({
      messageId: original.id,
      conversationId,
    });
    expect(await prisma.message.count({ where: { id: original.id } })).toBe(0);

    const history = await api()
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", bearer(recipient.token));
    expect(history.body.data).toEqual([]);
  });

  it("rejects prohibited edited content without changing the stored message", async () => {
    const { sender, conversationId } = await createConversation();
    const original = await sendInitialMessage(sender.token, conversationId);
    const edit = await api()
      .patch(`/api/v1/conversations/${conversationId}/messages/${original.id}`)
      .set("Authorization", bearer(sender.token))
      .send({
        body: "Reach me at https://wa.me/491761234567",
        revision: original.revision,
      });

    expect(edit.status).toBe(422);
    expect(edit.body.error.details.moderation.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "PHONE" }),
        expect.objectContaining({ kind: "WHATSAPP" }),
      ]),
    );
    const stored = await prisma.message.findUnique({
      where: { id: original.id },
    });
    expect(stored).toMatchObject({
      body: "Original message",
      editedAt: null,
      revision: 0,
    });
  });
});
