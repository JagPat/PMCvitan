-- AlterTable: per-option sample photo for issued decisions (swatch stays the fallback)
ALTER TABLE "DecisionOption" ADD COLUMN "photoUrl" TEXT;
