-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'REJECTED', 'MISSED', 'CANCELLED', 'ENDED');

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "caller_id" UUID NOT NULL,
    "callee_id" UUID NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "ended_by_id" UUID,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calls_conversation_id_started_at_idx" ON "calls"("conversation_id", "started_at");

-- CreateIndex
CREATE INDEX "calls_callee_id_status_idx" ON "calls"("callee_id", "status");

-- CreateIndex
CREATE INDEX "calls_caller_id_status_idx" ON "calls"("caller_id", "status");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity invariants (mirrors the CHECK-constraint style of the earlier phases).

-- A call always has two distinct participants.
ALTER TABLE "calls" ADD CONSTRAINT "calls_no_self_call" CHECK ("caller_id" <> "callee_id");

-- `answered_at` is present exactly for answered calls (ACCEPTED / ENDED).
ALTER TABLE "calls" ADD CONSTRAINT "calls_answered_state_valid" CHECK (
    ("status" IN ('RINGING', 'REJECTED', 'MISSED', 'CANCELLED') AND "answered_at" IS NULL)
    OR ("status" IN ('ACCEPTED', 'ENDED') AND "answered_at" IS NOT NULL)
);

-- `ended_at` is present exactly for terminal states.
ALTER TABLE "calls" ADD CONSTRAINT "calls_ended_state_valid" CHECK (
    ("status" IN ('RINGING', 'ACCEPTED') AND "ended_at" IS NULL)
    OR ("status" IN ('REJECTED', 'MISSED', 'CANCELLED', 'ENDED') AND "ended_at" IS NOT NULL)
);

-- A call cannot end before it started, and cannot be answered outside its window.
ALTER TABLE "calls" ADD CONSTRAINT "calls_timeline_valid" CHECK (
    ("answered_at" IS NULL OR "answered_at" >= "started_at")
    AND ("ended_at" IS NULL OR "ended_at" >= "started_at")
    AND ("answered_at" IS NULL OR "ended_at" IS NULL OR "ended_at" >= "answered_at")
);

-- At most one live call per conversation. Application code enforces this per user too
-- (which a single index cannot express), but this closes the race between two callers.
CREATE UNIQUE INDEX "calls_one_active_per_conversation"
    ON "calls"("conversation_id")
    WHERE "status" IN ('RINGING', 'ACCEPTED');
