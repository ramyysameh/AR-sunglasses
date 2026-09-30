-- CreateTable
CREATE TABLE "ModelGeneration" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopGid" TEXT NOT NULL,
    "photoRefs" JSONB NOT NULL,
    "photoSetId" TEXT NOT NULL,
    "retryIndex" INTEGER NOT NULL DEFAULT 0,
    "autoRetried" BOOLEAN NOT NULL DEFAULT false,
    "providerJobId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "glbRef" TEXT,
    "calibration" JSONB,
    "paid" BOOLEAN,
    "chargeReported" BOOLEAN NOT NULL DEFAULT false,
    "modelAssetId" TEXT,
    "startedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelGeneration_modelAssetId_key" ON "ModelGeneration"("modelAssetId");

-- CreateIndex
CREATE INDEX "ModelGeneration_shop_status_idx" ON "ModelGeneration"("shop", "status");

-- CreateIndex
CREATE INDEX "ModelGeneration_shop_createdAt_idx" ON "ModelGeneration"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ModelGeneration_providerJobId_idx" ON "ModelGeneration"("providerJobId");

