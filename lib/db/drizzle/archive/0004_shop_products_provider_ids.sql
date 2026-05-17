ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "printify_product_id" text;
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "printify_variant_id" text;
ALTER TABLE "shop_products" ADD COLUMN IF NOT EXISTS "dsers_product_id" text;
