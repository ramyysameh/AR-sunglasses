-- Store the original uploaded GLB file name so the admin UI can label models
-- by name instead of a random id fragment. Nullable: pre-existing rows and
-- block-registered models may not have one.
ALTER TABLE "ModelAsset" ADD COLUMN "filename" TEXT;
