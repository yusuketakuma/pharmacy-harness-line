-- Optional public details that help patients decide whether and how to visit.
ALTER TABLE pharmacy_public_profiles ADD COLUMN prescription_reception_hours TEXT NOT NULL DEFAULT '' CHECK (length(prescription_reception_hours) <= 2000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN after_hours_note TEXT NOT NULL DEFAULT '' CHECK (length(after_hours_note) <= 1000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN services_note TEXT NOT NULL DEFAULT '' CHECK (length(services_note) <= 2000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN accessibility_note TEXT NOT NULL DEFAULT '' CHECK (length(accessibility_note) <= 1000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN supported_languages TEXT NOT NULL DEFAULT '' CHECK (length(supported_languages) <= 1000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN payment_methods TEXT NOT NULL DEFAULT '' CHECK (length(payment_methods) <= 1000);
ALTER TABLE pharmacy_public_profiles ADD COLUMN website_url TEXT NOT NULL DEFAULT '' CHECK (length(website_url) <= 2000);
