-- The merchant's per-model size, set with the slider on the model's card on the
-- Models page. Existing models default to 1, so nothing changes on storefronts.
ALTER TABLE "ModelAsset" ADD COLUMN "sizeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1;
