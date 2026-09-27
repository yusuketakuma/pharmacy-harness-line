# F33候補: 混在日時によるチャット履歴・未対応判定の誤り

CONFIRMED_BUG / P2、未修復。P=044e817d2685edad303bc1fe0708200855c0e3a8、primary/dev、ソース変更なし。入力と最終再現harness SHAはchat-time-input.json。

## 根拠
- webhook.tsのtext受信はjstNow()をmessages_log.created_atへ保存（+09:00）。outbound-line-delivery.ts prepareDeliveryのnow.toISOString()がsettleAcceptedへ渡り、同じcreated_atへZ形式を保存する。どちらも現行の通常writer。DB値の破損を仮定しない。
- conversations detailはbeforeをjuliandayで比較する一方ORDER BYは文字列。chatsのMAX/previewとconversations/inboxのmanual cutoffも文字列。
- 最終harnessは実Hono chats/conversations、実unanswered-inbox、実bootstrap+better-sqlite3+D1adapter、固定の合成tenant/staff/account。認証middleware自体は代替しており本番認証の検証ではない。
- incoming 2023-01-01T09:00:00.000+09:00 の1分後にmanual outgoing 2023-01-01T00:01:00.000Z。期待は最新outgoing、履歴ascending incoming→outgoing、返信済queue/inbox各0。実際は最新incoming、次page空、履歴逆順、preview incoming、queue/inbox各1。
- 合成情報のみ。実患者/本番データ被害の確認なし。

## 検証記録
環境 Node26.6.0/pnpm11.25.0、env -i PATH/TMPDIRのみ継承 LANG=C.UTF-8 CI=true NO_COLOR=1。
- 初期detail単独tsx: session60526 exit1、conversation-time-red.logに期待/実際の差。初期harnessは後でconsumer拡張されたため、このlogのみを現在のmts全体の証拠にしない。
- consumer拡張tsx: session73943、49901 exit1。@line-crm/db named export解決に失敗、これらは製品不具合の再現ではない。logを保存。
- Vitest+source aliasへ切替: session44102 exit1、staff fixture不足によるchat403後のdata参照失敗。製品欠陥の証拠から除外。
- 最終: pnpm exec vitest run --config docs/pharmacy/evidence/audit-20260922/conversation-time-vitest.config.ts、session43813 exit1、1FAIL（6期待差分）。conversation-time-consumers-verified-red.log。staff/member/account割当を追加、過去固定日時でclock依存を排除。最終再現は .test.ts と config.ts が正本。
- child chat-time-consumer-review.mdを親全文読取し6path hash一致確認。子は独自runtime未実施、fresh最終レビューではない。

## 次の修復単位
writerだけ揃えても既存行は修復されない。chats/conversations/inboxのreader比較・argmax・order/cursorを同じ時刻軸へ揃える、既存raw timestamp/HTTP/tenant/staff/送信契約を維持する凝集packetが必要。既存migrationの変更や保存行の削除はしない。
UTCのみ/JSTのみ/混在/日付跨ぎ/同秒ms、既存before strict<と複合cursor、一覧previewとpage sort、既存scope/resolved/postback/test/自動返信5秒窓を検証する。対象50/500/5000件の旧新query plan/中央値比較を修復前に定義する。式によるindex利用減少は未評価。
同一instant多数行のbeforeId拡張は別契約課題で、今回の日時混在修復に黙って含めない。

状態: 全体監査PARTIAL、F33未修復、commit/patchなし。新全量test/buildはproduct無変更につき反復せず、F32成功結果を維持。nativeD1/CI Node22/実provider/性能比較未実施。
