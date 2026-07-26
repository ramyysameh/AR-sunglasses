-- CreateTable
CREATE TABLE "ShopSubscription" (
    "shop" TEXT NOT NULL,
    "planName" TEXT,
    "status" TEXT NOT NULL,
    "graceEndsAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSubscription_pkey" PRIMARY KEY ("shop")
);

