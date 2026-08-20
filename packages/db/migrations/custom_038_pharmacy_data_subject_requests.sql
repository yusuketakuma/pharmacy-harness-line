-- APPI 開示・訂正・利用停止・消去請求の受付〜本人確認〜法定保存対象判定〜
-- legal hold〜結果記録までの運用ワークフロー。
--
-- 個人情報取扱事業者は各テナント(薬局)であり、この表はテナント境界の内側でのみ
-- 完結する。保存するのは「請求の手続状態」だけで、患者のPHIそのものは複製しない。
--
-- legal hold の判定基準(2026-08-19 経営判断): 全PHIを一律3年保存する。
-- 薬剤師法施行規則の調剤録・処方箋の保存期間を準用したもので、対象データの
-- 最新PHI記録が3年を経過していなければ法定保存中として消去・利用停止に応じない。
--
-- `pharmacy_patients.archived_at`(アーカイブ)はこのワークフローの代替ではない。
-- アーカイブは法定保存中のデータを通常業務の一覧から隠すだけの運用上の操作であり、
-- 法的な消去対応にはならない。両者は別物として併存する。

CREATE TABLE IF NOT EXISTS pharmacy_data_subject_requests (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  line_account_id        TEXT NOT NULL,
  owner_friend_id        TEXT NOT NULL,
  patient_id             TEXT NOT NULL,
  request_type           TEXT NOT NULL
    CHECK (request_type IN ('access', 'correction', 'suspension', 'erasure')),
  status                 TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'identity_verified', 'legal_hold_assessed',
                      'resolved', 'rejected')),
  reason                 TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  legal_hold             INTEGER CHECK (legal_hold IS NULL OR legal_hold IN (0, 1)),
  legal_hold_basis       TEXT CHECK (legal_hold_basis IS NULL OR
                                     legal_hold_basis = 'pharmacist_law_enforcement_regulation_3y'),
  legal_hold_release_at  TEXT,
  outcome_note           TEXT CHECK (outcome_note IS NULL OR length(outcome_note) <= 2000),
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at           TEXT NOT NULL,
  identity_verified_at   TEXT,
  legal_hold_assessed_at TEXT,
  resolved_at            TEXT,
  resolved_by            TEXT,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  UNIQUE (id, line_account_id),
  -- 本人確認前に法定保存判定へ進めない / 判定前に結果を確定できない。
  CHECK (status <> 'identity_verified' OR identity_verified_at IS NOT NULL),
  CHECK (status <> 'legal_hold_assessed' OR
         (identity_verified_at IS NOT NULL AND legal_hold IS NOT NULL AND
          legal_hold_assessed_at IS NOT NULL)),
  CHECK (status NOT IN ('resolved', 'rejected') OR
         (legal_hold IS NOT NULL AND resolved_at IS NOT NULL AND
          resolved_by IS NOT NULL AND outcome_note IS NOT NULL)),
  -- 法定保存期間中は消去・利用停止に応じられない。応じられない旨を記録して
  -- 'rejected' で閉じるしかない構造にする(アプリ側の判断に依存させない)。
  CHECK (status <> 'resolved' OR legal_hold = 0 OR
         request_type IN ('access', 'correction')),
  FOREIGN KEY (tenant_id, line_account_id)
    REFERENCES tenant_line_accounts(tenant_id, line_account_id),
  FOREIGN KEY (patient_id, line_account_id, owner_friend_id)
    REFERENCES pharmacy_patients(id, line_account_id, owner_friend_id),
  FOREIGN KEY (line_account_id, created_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id),
  FOREIGN KEY (line_account_id, resolved_by)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_data_subject_requests_queue
  ON pharmacy_data_subject_requests (line_account_id, status, submitted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_pharmacy_data_subject_requests_patient
  ON pharmacy_data_subject_requests (line_account_id, patient_id, submitted_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS pharmacy_data_subject_request_events (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL,
  event_type      TEXT NOT NULL
    CHECK (event_type IN ('received', 'identity_verified', 'legal_hold_assessed',
                          'resolved', 'rejected')),
  actor_staff_id  TEXT NOT NULL,
  detail          TEXT CHECK (detail IS NULL OR length(detail) <= 2000),
  occurred_at     TEXT NOT NULL,
  UNIQUE (line_account_id, request_id, event_type),
  FOREIGN KEY (request_id, line_account_id)
    REFERENCES pharmacy_data_subject_requests(id, line_account_id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id, actor_staff_id)
    REFERENCES pharmacy_staff_accounts(line_account_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_data_subject_request_events_request
  ON pharmacy_data_subject_request_events (line_account_id, request_id, occurred_at, id);

CREATE TRIGGER IF NOT EXISTS pharmacy_data_subject_events_no_update
BEFORE UPDATE ON pharmacy_data_subject_request_events
BEGIN SELECT RAISE(ABORT, 'DATA_SUBJECT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS pharmacy_data_subject_events_no_delete
BEFORE DELETE ON pharmacy_data_subject_request_events
BEGIN SELECT RAISE(ABORT, 'DATA_SUBJECT_EVENT_IMMUTABLE'); END;
