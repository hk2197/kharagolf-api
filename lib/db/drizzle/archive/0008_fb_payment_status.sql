-- Add payment tracking columns to fb_orders
ALTER TABLE fb_orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending';
ALTER TABLE fb_orders ADD COLUMN IF NOT EXISTS payment_reference text;
