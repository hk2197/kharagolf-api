-- KharaGolf seed data
-- Run after drizzle-kit push to initialize default organization data

-- Set default org logo to crest logo
UPDATE organizations SET logo_url = '/logo.png' WHERE id = 1 AND (logo_url IS NULL OR logo_url = '');
