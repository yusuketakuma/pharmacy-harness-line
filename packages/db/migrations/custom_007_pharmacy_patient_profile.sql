-- Optional contact and delivery address fields for pharmacy patient profiles.
-- Existing patient rows remain valid and keep all new fields NULL.
ALTER TABLE pharmacy_patients ADD COLUMN postal_code TEXT;
ALTER TABLE pharmacy_patients ADD COLUMN prefecture TEXT;
ALTER TABLE pharmacy_patients ADD COLUMN city TEXT;
ALTER TABLE pharmacy_patients ADD COLUMN address_line1 TEXT;
ALTER TABLE pharmacy_patients ADD COLUMN address_line2 TEXT;
