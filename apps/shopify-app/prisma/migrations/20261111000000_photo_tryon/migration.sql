-- Photo try-on request counter (spec 2026-11-11): daily limits per shopper
-- and per shop. Stores no photos and no raw IPs.
CREATE TABLE "PhotoTryon" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoTryon_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PhotoTryon_shop_createdAt_idx" ON "PhotoTryon"("shop", "createdAt");

CREATE INDEX "PhotoTryon_clientKey_createdAt_idx" ON "PhotoTryon"("clientKey", "createdAt");
