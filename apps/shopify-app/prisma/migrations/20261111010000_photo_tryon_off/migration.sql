-- Products a merchant switched photo try-on off for. On is the default, so
-- only exceptions are stored.
CREATE TABLE "PhotoTryonOff" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoTryonOff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhotoTryonOff_shop_productId_key" ON "PhotoTryonOff"("shop", "productId");
