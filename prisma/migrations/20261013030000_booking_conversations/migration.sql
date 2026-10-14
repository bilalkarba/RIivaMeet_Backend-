-- Link existing private conversations to an accepted booking when applicable.
-- NULL preserves existing direct conversations; the unique index permits only
-- one booking conversation while leaving non-booking conversations unchanged.
ALTER TABLE "conversations" ADD COLUMN "booking_id" UUID;

CREATE UNIQUE INDEX "conversations_booking_id_key" ON "conversations"("booking_id");

ALTER TABLE "conversations"
    ADD CONSTRAINT "conversations_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
