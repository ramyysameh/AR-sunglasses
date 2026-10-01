-- AlterTable
ALTER TABLE "ModelGeneration" ADD COLUMN     "photoSource" TEXT NOT NULL DEFAULT 'upload',
ADD COLUMN     "productHandle" TEXT,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "productTitle" TEXT;

