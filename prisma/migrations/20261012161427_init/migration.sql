-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'COACH', 'ADMIN');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bio" TEXT NOT NULL,
    "hourly_price" DECIMAL(10,2) NOT NULL,
    "experience_level" "ExperienceLevel" NOT NULL,
    "city" TEXT NOT NULL,
    "neighborhood" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coach_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sports" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_sports" (
    "coach_profile_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_sports_pkey" PRIMARY KEY ("coach_profile_id","sport_id")
);

-- CreateTable
CREATE TABLE "availabilities" (
    "id" UUID NOT NULL,
    "coach_profile_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "coach_profile_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "price_at_booking" DECIMAL(10,2) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "coach_profile_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "coach_profiles_user_id_key" ON "coach_profiles"("user_id");

-- CreateIndex
CREATE INDEX "coach_profiles_is_published_hourly_price_idx" ON "coach_profiles"("is_published", "hourly_price");

-- CreateIndex
CREATE INDEX "coach_profiles_city_neighborhood_idx" ON "coach_profiles"("city", "neighborhood");

-- CreateIndex
CREATE INDEX "coach_profiles_latitude_longitude_idx" ON "coach_profiles"("latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "sports_name_key" ON "sports"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sports_slug_key" ON "sports"("slug");

-- CreateIndex
CREATE INDEX "coach_sports_sport_id_idx" ON "coach_sports"("sport_id");

-- CreateIndex
CREATE INDEX "availabilities_coach_profile_id_start_at_idx" ON "availabilities"("coach_profile_id", "start_at");

-- CreateIndex
CREATE INDEX "availabilities_coach_profile_id_is_available_start_at_end_a_idx" ON "availabilities"("coach_profile_id", "is_available", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "bookings_client_id_status_idx" ON "bookings"("client_id", "status");

-- CreateIndex
CREATE INDEX "bookings_coach_profile_id_status_idx" ON "bookings"("coach_profile_id", "status");

-- CreateIndex
CREATE INDEX "bookings_coach_profile_id_start_at_end_at_idx" ON "bookings"("coach_profile_id", "start_at", "end_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX "reviews_coach_profile_id_created_at_idx" ON "reviews"("coach_profile_id", "created_at");

-- AddForeignKey
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_sports" ADD CONSTRAINT "coach_sports_coach_profile_id_fkey" FOREIGN KEY ("coach_profile_id") REFERENCES "coach_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_sports" ADD CONSTRAINT "coach_sports_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availabilities" ADD CONSTRAINT "availabilities_coach_profile_id_fkey" FOREIGN KEY ("coach_profile_id") REFERENCES "coach_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_coach_profile_id_fkey" FOREIGN KEY ("coach_profile_id") REFERENCES "coach_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_coach_profile_id_fkey" FOREIGN KEY ("coach_profile_id") REFERENCES "coach_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
