-- DropIndex
DROP INDEX "ModelAsset_sourceUrl_key";

-- CreateIndex
CREATE UNIQUE INDEX "ModelAsset_shop_sourceUrl_key" ON "ModelAsset"("shop", "sourceUrl");

