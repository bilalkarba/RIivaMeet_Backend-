-- Coach verification.
--
-- Fully additive: three new tables, four new enums and one new relation on the existing
-- `users` table (no column/table/row is dropped or rewritten). It can therefore be applied
-- to a database that already holds production data.
--
-- No data is backfilled on purpose: existing coach profiles are NOT auto-approved. They
-- simply have no verification row, which means they are not publicly discoverable until an
-- administrator reviews them (see the README section "Coach verification" for the
-- deliberate rollout procedure).

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('DRAFT', 'PENDING', 'IN_REVIEW', 'NEEDS_INFO', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "VerificationDocumentType" AS ENUM ('DIPLOMA', 'CERTIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "VerificationEventType" AS ENUM ('APPLICATION_STARTED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REMOVED', 'SUBMITTED', 'RESUBMITTED', 'MARKED_IN_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'AI_ANALYSIS_STARTED', 'AI_ANALYSIS_COMPLETED', 'AI_ANALYSIS_FAILED');

-- CreateTable
CREATE TABLE "coach_verifications" (
    "id" UUID NOT NULL,
    "coach_profile_id" UUID NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(3),
    "last_submitted_at" TIMESTAMPTZ(3),
    "ai_status" "AiAnalysisStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "ai_result" JSONB,
    "ai_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_summary" TEXT,
    "ai_error_code" TEXT,
    "ai_attempts" INTEGER NOT NULL DEFAULT 0,
    "ai_analyzed_input_hash" TEXT,
    "ai_analyzed_at" TIMESTAMPTZ(3),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coach_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_verification_documents" (
    "id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "type" "VerificationDocumentType" NOT NULL,
    "storage_provider" TEXT NOT NULL,
    "storage_bucket" TEXT,
    "storage_key" TEXT NOT NULL,
    "original_file_name" TEXT,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "checksum_sha256" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(3),
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coach_verification_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_verification_events" (
    "id" UUID NOT NULL,
    "verification_id" UUID NOT NULL,
    "type" "VerificationEventType" NOT NULL,
    "from_status" "VerificationStatus",
    "to_status" "VerificationStatus",
    "actor_user_id" UUID,
    "actor_role" "Role",
    "note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_verifications_coach_profile_id_key" ON "coach_verifications"("coach_profile_id");

-- CreateIndex
CREATE INDEX "coach_verifications_status_submitted_at_idx" ON "coach_verifications"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "coach_verifications_ai_status_idx" ON "coach_verifications"("ai_status");

-- CreateIndex
CREATE INDEX "coach_verifications_reviewed_by_id_idx" ON "coach_verifications"("reviewed_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "coach_verification_documents_storage_key_key" ON "coach_verification_documents"("storage_key");

-- CreateIndex
CREATE INDEX "coach_verification_documents_verification_id_is_current_idx" ON "coach_verification_documents"("verification_id", "is_current");

-- CreateIndex
CREATE INDEX "coach_verification_documents_verification_id_type_idx" ON "coach_verification_documents"("verification_id", "type");

-- CreateIndex
CREATE INDEX "coach_verification_events_verification_id_created_at_idx" ON "coach_verification_events"("verification_id", "created_at");

-- AddForeignKey
ALTER TABLE "coach_verifications" ADD CONSTRAINT "coach_verifications_coach_profile_id_fkey" FOREIGN KEY ("coach_profile_id") REFERENCES "coach_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_verifications" ADD CONSTRAINT "coach_verifications_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_verification_documents" ADD CONSTRAINT "coach_verification_documents_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "coach_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_verification_events" ADD CONSTRAINT "coach_verification_events_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "coach_verifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_verification_events" ADD CONSTRAINT "coach_verification_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Integrity invariants (mirrors the hand-written CHECK-constraint style of the earlier phases).

-- A decided application always records its reviewer; an undecided one never does.
ALTER TABLE "coach_verifications" ADD CONSTRAINT "coach_verifications_review_state_valid" CHECK (
    ("status" IN ('APPROVED', 'REJECTED') AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
    OR ("status" IN ('DRAFT', 'PENDING', 'IN_REVIEW', 'NEEDS_INFO') AND "reviewed_by_id" IS NULL AND "reviewed_at" IS NULL)
);

-- The AI attempt counter is a cost guard and can never be negative.
ALTER TABLE "coach_verifications" ADD CONSTRAINT "coach_verifications_ai_attempts_non_negative" CHECK ("ai_attempts" >= 0);

-- A document only counts as current after its upload was confirmed against storage.
ALTER TABLE "coach_verification_documents" ADD CONSTRAINT "coach_verification_documents_current_is_confirmed" CHECK ("is_current" = false OR "confirmed_at" IS NOT NULL);

-- Object sizes, when known, are never negative.
ALTER TABLE "coach_verification_documents" ADD CONSTRAINT "coach_verification_documents_size_non_negative" CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0);
