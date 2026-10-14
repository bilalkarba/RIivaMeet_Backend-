-- Safety (Phase 2) invariants that the Prisma schema language cannot express, plus a
-- restoration of the documented `coach_sports` search index.
--
-- `prisma migrate dev` generated the `blocks`/`reports` tables; it also dropped
-- "coach_sports_sport_id_coach_profile_id_idx" (added by the earlier hand-written
-- check-constraints migration) because it is not declared in schema.prisma. That index is
-- the secondary access path of the coach search query, so it is recreated here.

CREATE INDEX IF NOT EXISTS "coach_sports_sport_id_coach_profile_id_idx"
    ON "coach_sports" ("sport_id", "coach_profile_id");

-- A user cannot block themselves.
ALTER TABLE "blocks"
    ADD CONSTRAINT "blocks_no_self_block" CHECK ("blocker_id" <> "blocked_id");

-- A user cannot report themselves.
ALTER TABLE "reports"
    ADD CONSTRAINT "reports_no_self_report"
        CHECK ("target_type" <> 'USER' OR "reporter_id" <> "target_id");

-- Moderation state and review information must stay consistent: a report is either
-- PENDING (no reviewer yet) or decided (reviewer + timestamp recorded).
ALTER TABLE "reports"
    ADD CONSTRAINT "reports_review_state_valid"
        CHECK (
            ("status" = 'PENDING' AND "reviewed_by_id" IS NULL AND "reviewed_at" IS NULL)
            OR ("status" <> 'PENDING' AND "reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
        );

-- USER reports must name the reported user (and reference it as the target); non-user
-- targets leave it null so the moderation query (`WHERE target_user_id = ...`) stays exact.
ALTER TABLE "reports"
    ADD CONSTRAINT "reports_target_user_consistent"
        CHECK (
            ("target_type" = 'USER' AND "target_user_id" IS NOT NULL AND "target_id" = "target_user_id")
            OR ("target_type" <> 'USER' AND "target_user_id" IS NULL)
        );
