ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "printful_product_id";
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "printful_variant_id";
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "printify_product_id";
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "printify_variant_id";
ALTER TABLE "shop_products" DROP COLUMN IF EXISTS "dsers_product_id";
ALTER TABLE "shop_orders" DROP COLUMN IF EXISTS "printful_order_id";
ALTER TABLE "shop_orders" DROP COLUMN IF EXISTS "printify_order_id";
ALTER TABLE "shop_orders" DROP COLUMN IF EXISTS "dsers_order_id";
