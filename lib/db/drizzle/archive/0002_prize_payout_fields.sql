ALTER TABLE "prize_awards" ADD COLUMN IF NOT EXISTS "award_amount" numeric(10, 2);
ALTER TABLE "prize_awards" ADD COLUMN IF NOT EXISTS "award_currency" text;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "prize_distribution_status" text;
