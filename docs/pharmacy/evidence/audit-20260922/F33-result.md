# F33 受入記録

ID F33 FIX、CONFIRMED_BUG/P2。owner /root、dev既存checkout。P=044e817d2685edad303bc1fe0708200855c0e3a8、H/Bはbaseline.jsonの開始状態。WはF33-W.json4path SHA、patch F33.patch（新test含む）。

## 変更と契約
- chats/conversations/unanswered-inboxのreaderを、UTC/JST文字列順からjulianday/Date.parseの瞬間比較へ変更。raw timestamps、DB保存値、schema、writer、公開route/field名・型・必須条件を維持。
- 各MAXでraw日時と該当rowを結び付け、inboxはkind別argmaxをpivotする。latest previewと未対応manual cutoffも同じ時間軸。
- 一覧page sortと公開lastMessageAtは既存の最新非test message時刻（messageなしのみchat timestamp）へ統一。初期候補のmetadata優先は公開field意味を変えるため親の最終点検で訂正した。初期成果は*.initialへ保存し、修正後の検証/reviewを別に記録。
- tenant/staff/account、resolved/postback/test除外、auto evidence1対1・5秒、旧before timestamp strict<、limit/offsetと複合cursorを保持。旧テストの削除・弱体化なし。新10ケースは実bootstrap/SQLite+Honoで確認。

## 検証
環境: env -i PATH/TMPDIRのみ継承 LANG=C.UTF-8 CI=true NO_COLOR=1、Node26.6.0/pnpm11.25.0、ローカル合成データのみ。

1. P+初期新test: pnpm --filter worker test src/routes/crm/chat-time.test.ts、F33-red.log、exit1/6FAIL3PASS。最終testを隔離P3sourceへコピーし再実行: F33-final-test-on-P.log、6FAIL4PASS（実製品欠陥assertion）。現在treeの巻戻しなし。
2. 初期近傍6files86PASS (F33-near-initial.log)。最終候補追加NULLテスト前にも6files86PASS (F33-near-final.log)、最後の10caseは全Worker検証で実行済。
3. 初期候補 pnpm verify:ci: integration-F33-verify.log、exit0、workspace型/テスト/dependency build/scripts/migration28PASS。最終revisionはWorker route/testのみで、影響Worker全体test/typecheck・native/performanceを再実施。他workspace不変範囲は再利用。
4. 最終 pnpm --filter worker test: F33-worker-final.log、exit0/270files3006PASS。pnpm --filter worker typecheck: F33-typecheck-final.log、exit0。
5. 最終 node F33-native-scope.mjs: F33-native-scope.json/log、build+runtime exit0。165354B、SHA256 84f6be74a193eec8d7f530eb43110f14eebbc60650abe964abbbccac7ac6c7aa。実compiled route/resourceguard/inbox、固定合成identity、localMiniflareD1全bootstrap、最新/順序/cursor/list/返信済queue/inbox/新incoming、egress0。fullapp認証や本番の検証ではない。
6. 性能 python3 F33-performance.py: exit0。P/W実routeで捕捉した8種類のmessage SELECT、10friends、50/500/5000 messages、warmup3/run9/交互順中央値。最終0.611→0.669 / 1.671→1.692 / 12.334→12.704ms。事前W<=max(2P,P+15ms)全PASS。生query plans/全測定はF33-performance.json。rows scanned未測定。SQLite3ローカルの限定測定で、本番D1全規模のSLO保証ではない。
7. 隔離Pへ4path patch適用しW全bytes一致。git diff --check exit0。

## レビュー・限界
既存childのF33-limited-review.mdとfinal追補を親全文読取、最終4hash一致を照合。阻害findingなし。独自child testなし、fresh-context全体最終reviewは未完。
- 同instantのbare-column argmax tieは任意候補という既存制約、全NULL timestampを越えるcursorや不正/非ISO/microsecond以上の日時完全互換は保証しない。過去timezoneなし日時の意味を新たに定義/変換していない。
- 同instant複数messageをtimestamp-only cursorで全件辿る機能は別課題として未解決。
- 全体監査/旧配布migration信頼根拠/CI Node22/実LINE/本番/完全Workerデプロイartifactでの全経路は未確認。SQL修復のcompiled synthetic runtimeとrelease完了を同一視しない。
- 新module/public export/manifest/build/asset配置変更なし。新配布入口の互換試験は非該当。
- PLANS/evidenceの先行未stage差分を保全、今回4pathだけlocal commit f3d3dc401a8859dd137bb9163752e9bb3425c124 に統合。外部操作なし。
