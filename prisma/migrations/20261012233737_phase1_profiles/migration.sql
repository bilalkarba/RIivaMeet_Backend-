-- DropIndex
DROP INDEX "coach_sports_sport_id_coach_profile_id_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "level" "ExperienceLevel";

-- CreateTable
CREATE TABLE "user_sports" (
    "user_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "level" "ExperienceLevel",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sports_pkey" PRIMARY KEY ("user_id","sport_id")
);

-- CreateIndex
CREATE INDEX "user_sports_sport_id_idx" ON "user_sports"("sport_id");

-- CreateIndex
CREATE INDEX "users_city_country_idx" ON "users"("city", "country");

-- AddForeignKey
ALTER TABLE "user_sports" ADD CONSTRAINT "user_sports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sports" ADD CONSTRAINT "user_sports_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
