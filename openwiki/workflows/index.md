# ファイル

- [Growth Loop・リッチメニュー・ベータ参加](growth-loop-and-rich-menu.md) - 薬局の機能有効化(capability)と Growth Loop の設定・当日の対応キュー・KPI、リッチメニューの版管理と公開前確認、ベータ参加(membership)による患者操作の制御と送信時の再確認を説明する。
- [LINE webhook と送信配信](line-webhook-and-outbound-delivery.md) - LINE webhook の検証と durable inbox による受信・再実行、薬局モードでの受信処理、LINE Harness Proxy 経由の送信(手動送信の source=manual と薬局の自動通知の承認)、outbound_line_deliveries による配信の追跡と再試行を説明する。
- [薬局の自動通知(PHI-free テンプレート)](pharmacy-notifications.md) - 薬局の患者向け自動通知が、承認済みテンプレートと単一の送信関門 sendPharmacyAutomatedPush を通る仕組み、冪等・上限・停止・ベータ参加の再確認、各ドメイン(処方箋・継続・服薬フォロー・使用期限)のキュー処理、スタッフ向け activity 通知を説明する。
- [薬局の患者導線(処方箋・問診・服薬フォロー・継続・EC・マイナ)](pharmacy-patient-journeys.md) - 薬局の患者向け各ドメイン(処方箋受付、問診、電子処方箋の引継ぎ、服薬フォロー、継続案内、緊急避妊の事前情報、履行見積り、利用状況タイムライン)の状態遷移、LIFF と管理画面 API の対応、共通の認可・冪等・後方互換の設計を説明する。
