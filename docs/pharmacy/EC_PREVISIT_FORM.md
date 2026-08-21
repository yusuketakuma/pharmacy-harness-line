# 緊急避妊薬 事前情報収集フォーム v2（product contract）

状態: Phase A/B 実装済み（ローカル）。実装は `PLANS.md` の `ECF` 節。precedence: 本書 > `PLANS.md`。

## 1. 方針（operator 裁定 2026-08-22）

- メーカーのチェックシートに相当する情報を **LINE(LIFF) で来局前に収集**し、**対面指導は必ず実施**したうえで所要時間を短縮する。
- 事前申告は「薬剤師が対面で再確認するための下書き」。**販売可否の authority にしない**。最終判断・販売記録は研修修了薬剤師。
- 旧 P8 EC-1 受入条件「病歴・月経を取得しない」は本書で **supersede** する。自由記載・性暴力詳細・画像は引き続き取得しない。
- メーカー紙チェックシートの受領と、販売記録との 2 年以上保存（医薬総発 0331 第 2 号 4(3)）は継続する。本システムは紙を置き換えない。

## 2. 一次情報

| 出典 | 使う事実 |
|---|---|
| 審査報告書（MHLW 001622315） | チェックシート＜その1＞=72h＋「してはいけないこと」、＜その2＞=「相談すること」＋直近月経・前回性交＋薬剤師記入欄（妊娠可能性判断フロー6項目）。＜その1＞の事前電話確認は適正使用に資する（p.10）。＜その2＞の事前電子収集についてMHLWの肯定記述はない |
| 医薬総発 0331 第 2 号 | 研修修了薬剤師、施行規則14条3/4項の販売記録、16歳未満・3か月2回以上→受診勧奨、18歳未満虐待疑い→児相通告、本人・年齢確認は可能な限り、ワンストップ紹介、3週間後の妊娠検査説明、チェックシート＋販売記録2年保存 |
| ノルレボ（第一三共HC）/ レソエル72（富士製薬・アリナミン製薬）添付文書 | しない: LNG アレルギー・肝臓病・妊婦・男性／授乳は24h回避。相談: 医師の治療中・薬アレルギー歴・心臓病/腎臓病/重度消化器疾患・セイヨウオトギリソウ。**両製品で同一** |
| アリナミン製薬 レソエル72 購入案内 | 来店前に「オンラインフォームまたはLINEチャット」でチェックシート回答する公式購入フロー |

## 3. 患者フォーム v2（全項目 構造化。自由記述なし。文言は中立語彙、製品名・メーカー名を出さない）

| 区分 | 項目 | 扱い |
|---|---|---|
| A1 | 服用する本人が来局し薬剤師の面前で服用する（既存 `patientWillVisit`+`acceptsInPersonDose` をそのまま使う。「(女性)」は付けない） | 未同意は送信不可（既存） |
| A2 | 対象となる出来事の日時（既存） | 入力直後に「服用期限」と残り時間を表示し、期限超過の枠は選択不可（既存 `outside_72_hours` を送信前に出す） |
| A3 | レボノルゲストレルを含む薬でアレルギー症状が出たことがある | 強フラグ。**送信は止めない**。代替導線（産婦人科・ワンストップ・他薬局）を同時表示 |
| A4 | 肝臓病の診断を受けている | 同上 |
| A5 | 現在妊娠している | 同上（受診勧奨対象） |
| A' | 授乳中 | フラグ（24時間授乳回避の説明用） |
| B1 | 医師の治療を受けている | フラグ。完了画面に「お薬手帳を持参」（実装: B1〜B4 のいずれか1つでもチェックされれば表示。より安全側） |
| B2 | 薬でアレルギー症状が出たことがある | フラグ |
| B3 | 心臓病・腎臓病・重度の消化器疾患の診断 | フラグ |
| B4 | セイヨウオトギリソウ（セント・ジョーンズ・ワート）を含む食品を摂っている | フラグ |
| C1 | 直近の月経開始日（不明可） | payload |
| C2 | 当てはまるものにチェック（複数可）／当てはまらない／わからない: 直近月経から約1か月超で月経なし・出産等の後に月経未回復・直近月経がいつもと違った（量が少ない/期間が短い）・直近月経以降、今回より前に妊娠の可能性が心配だった出来事があり3週間以上経過 | server が `pregnancy_test_recommended` を算出（**薬剤師のみ表示**、患者に見せない）。**未回答は『わからない』と同じ扱い（検査推奨）**: `noneApply` かつ月経開始日が既知の場合のみ `false`、それ以外（未回答・`unknown`・いずれかの signal 該当のいずれも）は `true` |
| D1 | 年齢（既存） | `under_16` / `minor_review`（既存） |
| D2 | 過去3か月の使用回数（既存）＋「回数で受付をお断りするものではありません」 | `repeat_purchase_review`（既存） |
| D3 | 本人確認書類を持参できる（任意） | payload |
| D4 | 安全な連絡方法（既存） | 既存 |
| E | 同意（既存1チェックに統合）: 申告は薬剤師が対面で再確認・最終判断は店頭・**申告の保存期間 N日 / 薬剤師の販売記録は法令により3年**・3週間後の妊娠検査の案内を受ける | `consent_version` 新版必須、`consent_content_hash` を intake に記録 |

削除: 「支援情報の希望」設問。代わりに完了画面・受付画面で全員に `support_center_url` を無条件表示（保存なし）。

## 4. 保存契約

- A3〜D3 と算出値（`pregnancy_test_recommended` 等）は **encrypted payload 内**（JSON に `schema_version: 2`）。envelope prefix `v1.`・鍵導出文字列・AAD キー順は変更しない。v1 行は欠損 null で読む。2048 byte 上限は最大 v2 payload を seal する Red test で実測し、超える場合のみ定数を上げる（上げる前に鍵導出を HMAC＋key version へ直す）。
- 平文列の追加は `risk_flags_json` への **`pre_review_flagged` 1個（内訳なし）** まで。`ADMIN_QUEUE_SELECT` に臨床列を足さない（回帰テストで固定）。
- 患者向け projection（`listOwnerEmergencyIntakes`）から `risk_flags`・`age_band` を外す（owner/admin projection を分離）。
- `checklist_version`（`product_code → version` の code 内 map）を intake・対面確認・販売記録に複写する。`manufacturer_check_url` は単一取扱製品前提を管理画面に注記（併売は別判断）。
- access audit に「どの項目を見たか」を足さない。

## 5. 薬剤師側（Phase B・実装済み）

- detail: A〜D をセクション別に「申告（未確認）」表示。**対面確認はセクション単位の✓＋「申告と相違があった項目」だけ個別マーク**（薬剤師ID・時刻）。A セクション✓なしでは `completed` に遷移できない（CAS UPDATE の WHERE に畳む。trigger は作らない）。
  - API: `PUT /api/custom/pharmacy/emergency-contraception/intakes/:id/counter-confirmations/:section`（`section` は `A`/`B`/`C`/`D`）。`pharmacy_emergency_counter_confirmations` へ `INSERT ... ON CONFLICT (line_account_id, intake_id, section) DO UPDATE` で upsert する — セクションを再確認しても行が増えず、最新の確認だけが残る。`mismatch_items_json` には申告フィールドのキー（例: `lngAllergy`）だけを保持し、患者の実際の回答値は含まない。
  - `event_type` の CHECK は additive-only で拡張していないため、対面確認そのものには専用の管理イベントを作らない（別テーブルの行そのものが記録）。
  - `GET /api/custom/pharmacy/emergency-contraception/intakes/:id/counter-confirmations/:section` で単一セクションの確認状態を取得する。
- 販売記録 `pharmacy_emergency_sale_records`（additive、immutable trigger、`UNIQUE(line_account_id, intake_id)`、`owner_friend_id` 保持で legal hold 対象）:
  - API: `POST /api/custom/pharmacy/emergency-contraception/intakes/:id/sale`（`sale:{intakeId}` の idempotency key で再送は既存の不変レコードをそのまま返す）、`GET .../sale` で取得。
  - 平文: `outcome(sold|refused)`、`sold_at`、`product_code`、`quantity=1`、`pharmacist_staff_id`、`training_registration_number`（複写）、`in_person_dose`、`identity_check(document|verbal|unverified)`、`checklist_sheets_received`、`checklist_version`
  - **暗号化**（`determination_encrypted`）: 妊娠検査結果、販売不可理由コード、受診勧奨先、紹介先（児相通告を含む）、説明済み項目
  - 販売不可は `status='cancelled'` ＋ `outcome='refused'`（status/event_type の CHECK は拡張不可）。管理画面の「薬剤師記入欄」で「販売」を「販売しなかった」にすると、理由（年齢確認不能／禁忌に該当／チェックシート不備／本人の辞退／その他）の選択が現れる。
  - 保存 class は **一律3年**（2年は法令下限）。`retention_days` redaction の対象外 — `pharmacy_emergency_intakes.encrypted_payload` の redaction は sale_records には及ばない。`determination_encrypted` を持つため、3年境界の実 purge が来たときは行削除ではなく `determination_encrypted` の redaction になる（`no_delete` trigger のため。`RETENTION_MATRIX.md` NEXT-5 順序表を参照）。
- 読み取りは `requireTrainedPharmacist` ＋ fail-closed access event。platform-admin からは `patient-operation` DEFERRED。

## 6. 非目標

販売可否の自動判定、紙チェックシート廃止、メーカー文言の転載、性暴力の有無を問う設問、支援希望の保存、3週間後の自動通知（店頭 opt-in の別設計）、複数製品同時取扱、自由記述、平文の臨床フラグ。

## 7. リリース分割

- **Phase A**（先行・小、実装済み）: A3/A4/A5/A' を payload v2 で追加、期限の事前表示、owner projection 分離、同意 v2、代替導線。schema 変更なし。
- **Phase B**（実装済み・ローカル）: B/C/D3、対面確認、販売記録（custom_051）、管理画面 detail/記入欄、manual 更新。
