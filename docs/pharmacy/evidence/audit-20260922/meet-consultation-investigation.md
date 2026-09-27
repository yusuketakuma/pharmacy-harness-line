# MEET-REGISTER-RACE-20260922-01 / 親の経路確認

子/root/audit_db、開始/終了HEAD dabec0034837607330729392f35189fd584ed68c。read-only、コード/Git/patch/commit/外部接続/spawnなし。登録146–265、direct send key/claim/settlement、SQLite fixture・登録rollback/insert race/generation testsを読取り。rg/cat/sed/git rev-parseのみ、子は実行再現なし。

確定した静的経路: 同account/event/payload A/Bがexisting=nullを読取り→A batchがconsultation/reminderを保存→B batchはconsultation conflictでowner IDへ収束するが、事前boolean !existing || scheduleChanged=1のままreminderを新delivery_id/pending/retry0/sent_atNULLへ更新。A/B間に配送があれば別keyによる再配送が可能。processing旧世代のsettlement CAS拒否は外部送信を取消せず新pendingを残す。実環境の頻度/被害は未確認。

不変条件は同世代再登録でID/状態維持、真の日程/宛先/URL変更時に新ID、consultation+必須reminder同batch。既存insert-race testはconsultationのみ先行作成しreminderが無くID保持を検査しない。既存reschedule testは異なる日時のみ。最小再現案はB batch入口でA登録、A reminder snapshot/sent状態を保存、B後に同一性をassert。親はPromise.allと2batch境界制御でnew/reschedule両方を実SQLite再現しF12へ。

親追加経路: routes/booking/meet-consultations.ts全文（tenant/friend account解決・staff assignment・201/400/404/409/503・承認済みconfirmation best-effort・cancel）。services/meet-consultation-reminders.ts全文（日時計算/JST表示・scope list/register/cancel・cron claims/delivery_id CAS）。index cron呼出はin-process proxyDispatchとcredential rootを渡す。webinar-consultation-bookingは呼出前後のみ、全booking domainの確認ではない。schema baseline対象2tablesと023 delivery_id追加を照合、対象tableの追加triggerは検索上無し。

日時契約: 前日=24時間前、1時間前、24時間内確定は次cron即時、1時間内確定は1通のみ。JST固定offset日付表示、実配送日から本日/明日を選ぶ。既存testsで境界あり。Date parserは厳密ISO/timezone要求より広い入力を許容する懸念は未確定（今回変更なし）。cancelはconsultationをcancelled、pending/failed reminderをcancelled、claim前の現statusで抑止。claim済み後のcancel/rescheduleと外部dispatchの競合は今回未実証・未修復。

薬局senderはmeet_consultation_v1/transactional_care/日時URLのみ、暗号化credential取得、genericは既存proxy。titleを通知本文に入れない。全proxy/senderの競合保証は以前の限定確認を再利用し今回scope外。F12でschema/API/export変更なし、独立レビュー/本番D1/LINE実配送は未実施。
