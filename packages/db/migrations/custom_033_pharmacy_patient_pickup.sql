-- Patient pickup preference and arrival signal remain account-scoped attributes
-- of the existing prescription submission; pharmacy fulfillment quotes stay authoritative.

ALTER TABLE pharmacy_prescription_submissions
  ADD COLUMN desired_fulfillment_method TEXT CHECK (
    desired_fulfillment_method IS NULL OR desired_fulfillment_method IN ('PICKUP','DELIVERY')
  );

ALTER TABLE pharmacy_prescription_submissions
  ADD COLUMN arrival_reported_at TEXT;
