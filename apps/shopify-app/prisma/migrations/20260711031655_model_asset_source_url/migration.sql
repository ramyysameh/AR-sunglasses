-- AlterTable
ALTER TABLE "ModelAsset" ADD COLUMN "sourceUrl" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ModelAsset_sourceUrl_key" ON "ModelAsset"("sourceUrl");
