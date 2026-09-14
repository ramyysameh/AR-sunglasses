-- A merchant-supplied name for a model. Display falls back to `filename`, then
-- to a short id. Nullable: every existing row keeps its current label.
ALTER TABLE "ModelAsset" ADD COLUMN "label" TEXT;

-- Last time the try-on engine fetched config for THIS product. Per-mapping, not
-- per-shop: a per-shop timestamp would mark every product live as soon as any
-- one product was used, hiding a broken product from the merchant. Null means
-- "never seen working", which is the correct starting state for existing rows.
ALTER TABLE "ProductMapping" ADD COLUMN "lastSeenLiveAt" TIMESTAMP(3);
