# F32 受入記録

- ID/type: F32 FIX、CONFIRMED_BUG/P1（機密本文を含み得る手動チャットの例外ログ）。owner /root、dev。
- P: da40c463db40423af8bbc32ce2ade603949bcffb。W: F32-W.json の2path SHA。H=B=f62b90acd41154ab07c27f13b89a70ecb0eaa452。
- 変更: chats.ts の send catch だけを固定 log(event,{},error) へ変更、既存 manual-message test に4ケース追加。既存テスト削除・弱体化なし。公開route/field/status/API/export/保存形式/migration変更なし。
- 根拠: 実Hono routeの c.req.json、flex/image JSON.parse と依存例外が生の Error としてconsole.errorへ渡る。合成 PHI_MARK がログへ現れる旧P regression4FAIL、既存10PASS。実データ/実患者被害の観測ではない。
- 初期testでは長い合成markerがJSON例外で短縮され、3ケースがログ形式assertionで失敗した。markerを8文字へ短縮し、最終REDでは全4ケースが機密marker流出assertionで失敗することを確認（初期ログも保存）。
- 契約: catchの範囲とHTTP500固定JSONは不変。正しい送信・source/manual・UUID・tenantcredential・境界拒否は既存テストで維持。catch後の送信/DB更新追加なし。例外の詳細を固定イベントへ置換することが唯一の意図的運用差分。

## 実施検証
共通環境: env -i PATH=継承 LANG=C.UTF-8 TMPDIR=継承 CI=true NO_COLOR=1、Node26.6.0/pnpm11.25.0、合成DB/mockのみ。

1. pnpm --filter worker test src/routes/crm/chats-manual-message.test.ts: F32-red-final.log、product P + 追加testで exit1 / 4FAIL10PASS。productを巻戻す操作なし。
2. pnpm --filter worker test src/routes/crm/chats-manual-message.test.ts src/routes/crm/chats-tenant-pair.test.ts src/routes/crm/chats-list.test.ts src/custom/pharmacy/logging-privacy.test.ts: F32-near.log、exit0 / 4files18PASS。
3. pnpm --filter worker typecheck: F32-typecheck.log、exit0。
4. pnpm verify:ci: integration-F32-verify.log、exit0。Worker269files2996PASS、scripts25files263PASS、additive migration28PASS、その他workspaceの既存検証も同log。
5. git diff --check: exit0。F32.patchをisolated temp gitのP2pathsにgit applyし、対象2pathsがWとbyte一致。

## 制約・統合
- 実route/loggerは使うがDB・credential・送信はmock。今回の修復はDB/送信処理を変更しない。full認証・nativeWorkerd・実providerの再検証、Worker生成物smoke、CI Node22は今回未実施。module/export/manifest/build/assetは変更しないため新たな配布入口検証は非該当。
- 例外がlogger呼出し前に依存内部で出力される全経路や他routeの生ログまではこのpacketの保証対象ではない。
- 限定レビュー F32-limited-review.md を親が全文読み、2path SHA一致を再確認。阻害findingなし。fresh-context全体最終レビューは未実施。
- patch: F32.patch、input/W SHA: F32-input.json/F32-W.json。local commit: 044e817d2685edad303bc1fe0708200855c0e3a8。終了コードはツール完了結果をF32-execution-status.jsonにも記録。PLANS/evidenceの先行未stage差分は保全。外部操作・本番アクセスなし。
