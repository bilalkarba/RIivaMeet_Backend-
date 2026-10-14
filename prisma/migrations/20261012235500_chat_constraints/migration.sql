-- Chat (Phase 3) invariants that the Prisma schema language cannot express, plus a
-- restoration of the `coach_sports` search index.
--
-- `prisma migrate dev` treats "coach_sports_sport_id_coach_profile_id_idx" as drift
-- unless it is declared in schema.prisma, and re-created it there for that reason. This
-- migration re-creates it for databases that already ran the earlier migrations.

CREATE INDEX IF NOT EXISTS "coach_sports_sport_id_coach_profile_id_idx"
    ON "coach_sports" ("sport_id", "coach_profile_id");

-- A message must contain something, and stay within the documented limit.
ALTER TABLE "messages"
    ADD CONSTRAINT "messages_body_length" CHECK (char_length("body") BETWEEN 1 AND 4000);
