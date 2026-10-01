-- One-off: models generated from a product before 2026-10-02 were all called
-- "AI model". Name them after their product (only where the merchant hasn't
-- renamed them).
UPDATE "ModelAsset" AS a
SET "label" = g."productTitle"
FROM "ModelGeneration" AS g
WHERE g."modelAssetId" = a."id"
  AND g."photoSource" = 'product'
  AND g."productTitle" IS NOT NULL
  AND a."label" IS NULL
  AND a."filename" = 'AI model';
