ALTER TABLE pharmacy_public_profiles ADD COLUMN fax_number TEXT NOT NULL DEFAULT '' CHECK (length(fax_number) <= 40);
