-- Domain invariants that the Prisma schema language cannot express.
-- Prisma Migrate generated the initial tables; these constraints are hand-written and
-- are applied by `prisma migrate deploy` like any other migration.

-- Money can never be negative.
ALTER TABLE "coach_profiles"
    ADD CONSTRAINT "coach_profiles_hourly_price_non_negative" CHECK ("hourly_price" >= 0);

-- Coordinates must be inside the valid WGS84 ranges (NULL is allowed while drafting,
-- but a published profile always has coordinates - enforced in the service layer).
ALTER TABLE "coach_profiles"
    ADD CONSTRAINT "coach_profiles_latitude_range"
        CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
    ADD CONSTRAINT "coach_profiles_longitude_range"
        CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));

-- An availability window must end after it starts.
ALTER TABLE "availabilities"
    ADD CONSTRAINT "availabilities_time_range_valid" CHECK ("end_at" > "start_at");

-- A booking must end after it starts and never carry a negative price.
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_time_range_valid" CHECK ("end_at" > "start_at"),
    ADD CONSTRAINT "bookings_price_non_negative" CHECK ("price_at_booking" >= 0);

-- Ratings are integers from 1 to 5.
ALTER TABLE "reviews"
    ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- Overlap lookups always target accepted bookings for one coach; a partial index keeps
-- those checks cheap as the table grows.
CREATE INDEX "bookings_coach_accepted_range_idx"
    ON "bookings" ("coach_profile_id", "start_at", "end_at")
    WHERE "status" = 'ACCEPTED';

-- Searching coaches by sport + published state is the secondary access path of the
-- search query (after the published/price filters).
CREATE INDEX "coach_sports_sport_id_coach_profile_id_idx"
    ON "coach_sports" ("sport_id", "coach_profile_id");

-- NOTE (optional hardening, requires the btree_gist extension):
-- Application-level overlap prevention runs inside SERIALIZABLE transactions. If your
-- PostgreSQL provider allows extensions, the same invariant can be enforced by the
-- database itself:
--
--   CREATE EXTENSION IF NOT EXISTS btree_gist;
--   ALTER TABLE "bookings"
--     ADD CONSTRAINT "bookings_no_overlapping_accepted"
--     EXCLUDE USING gist (
--       "coach_profile_id" WITH =,
--       tstzrange("start_at", "end_at", '[)') WITH &&
--     ) WHERE ("status" = 'ACCEPTED');
--
-- It is intentionally NOT part of this migration so the schema stays portable to
-- providers where the extension is unavailable.
