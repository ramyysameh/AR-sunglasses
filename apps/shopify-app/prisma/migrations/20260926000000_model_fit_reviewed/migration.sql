-- When a merchant reviewed a flagged model's fit and accepted it. Clears the
-- "Needs fit review" status without changing what shoppers see.
ALTER TABLE "ModelAsset" ADD COLUMN "fitReviewedAt" TIMESTAMP(3);
