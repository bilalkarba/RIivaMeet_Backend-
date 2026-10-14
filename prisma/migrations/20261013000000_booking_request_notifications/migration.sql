-- Persist coach-facing booking request alerts. The unique booking_id makes
-- notification creation idempotent for each successfully created booking.
CREATE TYPE "NotificationType" AS ENUM ('BOOKING_REQUEST');

CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'BOOKING_REQUEST',
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_booking_id_key" ON "notifications"("booking_id");
CREATE INDEX "notifications_recipient_id_read_at_created_at_idx"
    ON "notifications"("recipient_id", "read_at", "created_at");

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
