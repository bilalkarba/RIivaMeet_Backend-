-- Message moderation flags.
--
-- Additive only: one new table, no existing table/column/row is changed. A flag is created
-- when `MESSAGE_MODERATION_POLICY=flag` and a message contains off-platform contact
-- details. The message itself is still persisted and delivered; administrators review the
-- flag through /api/v1/admin/message-flags.
--
-- `matches` stores detector kinds/labels only (never the matched phone number or address).

CREATE TABLE "message_moderation_flags" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "policy" TEXT NOT NULL,
    "matches" JSONB NOT NULL,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_moderation_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "message_moderation_flags_message_id_idx" ON "message_moderation_flags"("message_id");
CREATE INDEX "message_moderation_flags_reviewed_at_created_at_idx" ON "message_moderation_flags"("reviewed_at", "created_at");
CREATE INDEX "message_moderation_flags_sender_id_created_at_idx" ON "message_moderation_flags"("sender_id", "created_at");

ALTER TABLE "message_moderation_flags"
    ADD CONSTRAINT "message_moderation_flags_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_moderation_flags"
    ADD CONSTRAINT "message_moderation_flags_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_moderation_flags"
    ADD CONSTRAINT "message_moderation_flags_sender_id_fkey"
    FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_moderation_flags"
    ADD CONSTRAINT "message_moderation_flags_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A flag is either pending (no reviewer) or reviewed (reviewer + timestamp recorded).
ALTER TABLE "message_moderation_flags"
    ADD CONSTRAINT "message_moderation_flags_review_state_valid"
    CHECK (
        ("reviewed_at" IS NULL AND "reviewed_by_id" IS NULL)
        OR ("reviewed_at" IS NOT NULL AND "reviewed_by_id" IS NOT NULL)
    );
