-- AlterTable
ALTER TABLE "coach_profiles" ADD COLUMN     "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[];
