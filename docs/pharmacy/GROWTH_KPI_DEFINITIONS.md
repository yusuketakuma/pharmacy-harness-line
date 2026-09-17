# 薬局統計 KPI 定義（正本）

`GET /api/custom/pharmacy/growth/dashboard`（`getGrowthDashboard`）の各指標の定義を固定する。
旧基準文書は削除済みのため、本書が UI 表示と監査照合の正本である。
集計はすべて `line_account_id` スコープ。患者識別子は一切含まない。

## 期間

- `from` / `to`: 選択月の日本時間の暫月境界（JST 月初 0:00 〜 翌月初 0:00、API は UTC ISO で受ける）。
- `observedThrough`: 観測打ち切り時刻。コホート成熟判定・unfollow 観測に使う。
- 成長イベントは `to + 90日` まで観測を延長して成熟を判定する。

## 入口（entry）

| フィールド | 表示 | 定義 |
|---|---|---|
| `firstTimeFollows` | 初回友だち追加 | 期間内の `first_follow` イベント数 |
| `measurableFollows` | 計測可能な友だち追加 | 期間内 follow のうち follow から30日の観測期間が `observedThrough` までに完了した件数 |
| `firstSubmissions` | （初回送信率の分子注記） | 期間内の `first_submission` イベント数 |
| `secondSubmissions` | （2回目送信率の分子注記） | 期間内の `second_submission` イベント数 |
| `firstSubmissionRate` | 初回送信率 | 分子: 成熟 follow コホートのうち follow 後30日以内に `first_friend_submission` した件数。分母: 成熟 follow コホート数 |
| `secondSubmissionRate` | 2回目送信率 | 分子: 成熟初回送信コホートのうち初回送信後90日以内に `second_submission` した件数。分母: 成熟初回送信コホート数 |

成熟コホート以外は「未成熟」として併記し、率の分母に含めない。

## 面分業（sources）

| フィールド | 表示 | 定義 |
|---|---|---|
| `primary` | 主な発行元 | 期間内に `accepted` になった受付のうち分類 `primary` の件数（合成テスト受付を除く） |
| `other` | その他の発行元 | 同上、分類 `other` |
| `unknown` | 発行元不明 | 同上、分類なし |
| `otherShare` | その他 ÷ 分類済み | `other / (primary + other)`。分類済み0件なら `—` |
| `knownDenominator` | 分類済み分母 | `primary + other` |
| `attributionCoverage` | 発行元分類率 | `(primary + other) / (primary + other + unknown)` |

## 約束（promises）

約束 = 準備見込み時刻（`estimated_ready_at`）を持つ有効な見積もり。対象は期間内に `ready` イベントがあり、見積もりが ready 以前に作成され、決定が `fulfillable` または条件付き（全要件充足）の `conditional`、失効していないもの。同一受付に複数見積もりがある場合は最新 revision を採用する。

| フィールド | 表示 | 定義 |
|---|---|---|
| `readyEvents` | 準備完了数 | 期間内の `ready` イベントを持つ受付数（取消・合成を除く） |
| `promised` | 準備予定あり | 有効な約束を持つ受付数 |
| `onTime` / `onTimeRate` | 予定内率 | `ready_at - estimated_ready_at <= graceMinutes`（現在0分）の割合。注記に `onTime/promised` を併記 |
| `late` | 遅延件数 | `promised` のうち予定時刻を超えて ready になった件数 |
| `p50LatenessMinutes` / `p90LatenessMinutes` | 遅延の中央値 / 90%地点 | 遅延分の分布（線形補間パーセンタイル）。遅延0件なら `—` |
| `promiseRevisionCount` | 予定時刻の版数 | 採用可否判定までに存在した見積もり版の総数 |
| `promiseWithoutReady` | （非表示） | 約束があるが期間内 ready が無い件数。現在のクエリは期間内 ready を結合条件とするため構造上常に0。将来の表示対象外とする |
| `promiseWithoutQuote` | 準備完了・予定なし | `readyEvents - promised`（下限0）。予定時刻を提示せずに準備完了した件数 |

## 使用期限（validity）

| フィールド | 表示 | 定義 |
|---|---|---|
| `verified` | 確認済み使用期限 | 期間内に作成された validity のうち `verified` |
| `reminderSent` | 期限前日通知 | 同上、期限前日リマインド送信済み |
| `reminderClosedInTime` | 期限前日通知後に期限内完了 | リマインド送信済みかつ `closed_at` の日付が `valid_until` 以下 |
| `expiredReviewRequired` | 期限確認が必要 | `expired_review_required` |
| `confirmedExpired` | 期限切れ確認済み | `expired_confirmed` |

## 通知（notifications）

`pharmacy_notification_events` を `category:outcome` で集計。outcome は `sent` / `attempted` / `failed` / `blocked`。

| フィールド | 表示 | 定義 |
|---|---|---|
| `counts[category:sent]` | 各カテゴリ送信数 | 受付・準備 / フォロー / 継続 / 能動的なお知らせ / 手動送信 |
| `proactiveCapBlocked` | 月間上限で見送り | `proactive_noncare:blocked` |
| `proactiveAttempts` | 能動通知の試行 | `proactive_noncare:*` の合計 |
| `attempted` | 送信試行 | 全 outcome 合計 |
| `reconciliationRequired` | 要確認（24時間超） | `attempted` のまま24時間を超えて未確定の件数。自動再送しない |
| `alertState` | 監視状態 | `alert_only` = 警告のみ / その他 = 設定保留（自動停止なし） |

## メッセージ（messaging）

`messages_log` を期間内に集計。`delivery_type = 'test'` は送信側から除外する。

| フィールド | 表示 | 定義 |
|---|---|---|
| `sent` / `received` | 送信記録数 / 受信記録数 | 方向別件数 |
| `manual` / `automated` / `sourceUnverified` | 手動 / 自動 / 送信元未確認 | `source` 属性による分類 |
| `push` / `reply` / `deliveryUnverified` | push / reply / 配信種別未確認 | `delivery_type` による分類 |
| `uniqueCorrespondents` | 一意の対応者数 | 受信または非テスト送信した friend の重複排除数 |
| `attempted` | LINE送信処理中 | `outbound_line_deliveries` で `open` の件数 |
| `reconciliationRequired` | LINE送信要確認 | 再送期限超過・結果不明・payload 不可で `retired` した件数 |
| `legacyUnscoped` | 旧記録（アカウント未確定） | 常に `未確認` 固定。現在の所属から数え直さない |

## LINEブロック監視（unfollow）

送信済み通知の72時間観測が完了した対象について、24/72時間以内の `unfollow` イベントを計測。表示は「推定される時間的関連」であり因果を断定しない。
