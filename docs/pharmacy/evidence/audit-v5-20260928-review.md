# audit-v5-20260928 独立レビュー受入記録

日付: 2026-09-28 / reviewer: `/root/independent_review`

## 判定

固定された採択差分について、静的レビューで新規のblocking defectは発見しなかった。**STATIC REVIEW COMPLETE / 動的受入 BLOCKED**。修正の方向、公開契約、主要consumerとの整合は確認したが、最終Iでのテスト成功・配布可能性・全監査完了を意味しない。広範なC01–C12/X01–X08監査は引き続きPARTIAL。

実装者のPASSを正しさの前提にせず、差分、主要caller/consumer、追加テストのアサーションを直接確認した。既存ログは実行済みsnapshotの証拠としてのみ扱った。

## 対象・境界

- 元repo: `/Users/yusuke/workspace/pharmacy-harness-line`
- review checkout: 元repoの `.git/audit-v5-20260928/integration`
- B=Pinitial: `6fa678b5df61ec78176e040cfeb8b8ca54ed9055`
- SOURCE I: `04d38cf67651fdada30f911b0e11cd8c2d4924b7`
- I tree: `1cdabbe28feb8e26810891ebdf6134a3c1b863e6`
- 対象はB→Iの5 FIX + 1 REFACTOR、14 source/test paths。Iはレビュー終了時も同一、対象sourceに未コミット差分なし。
- integrationの作成中 `PLANS.md` / `docs/README.md` / evidence 2文書はSOURCEレビュー対象外。証拠文書は参照したが内容の完成を承認していない。
- 元checkoutはBのままcleanと確認。source/config/index/branchを変更していない。書込みはこの記録だけ。再帰spawn、外部操作、秘密値・実データ読取り、targetコード/テスト/build/browser実行なし。
- 適用指示: 提供されたユーザーAGENTS、repoおよびapps/web・apps/worker・packagesのAGENTS、`agent-defaults`、`security-audit`。Devin wikiはrepo_identifierとoriginが一致するローカルwikiの概要のみ参照し、実コードと照合。
- jgの独自検索は行っていない。対象ファイル・symbol・callsiteが確定した差分レビューのため、直接readと正確なrg参照検索を使用した。委譲条件も外部操作禁止。親/実装者のjg結果を網羅性や正しさの証拠にしていない。未変更領域の全体探索・全repo再監査は対象外。

## changed paths

1. `packages/update-engine/src/bundle.ts`
2. `packages/update-engine/test/bundle.test.ts`
3. `apps/worker/src/middleware/auth.ts`
4. `apps/worker/src/middleware/auth.test.ts`
5. `apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.ts`
6. `apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.test.ts`
7. `apps/worker/src/custom/pharmacy/platform-admin/auth.ts`
8. `apps/worker/src/custom/pharmacy/platform-admin/auth-path.test.ts`
9. `packages/sdk/src/workflows.ts`
10. `packages/sdk/tests/workflows.test.ts`
11. `packages/line-sdk/src/client.ts`
12. `packages/line-sdk/test/client.test.ts`
13. `apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx`
14. `apps/web/e2e/emergency-draft-scope.e2e.ts`

## 差分・契約・反証確認

### F01 / R01: bundle終了処理とbucket振分け

- `bundle.ts:49–117`。入力・gunzip・tar extractorをNode `pipeline`が所有し、callbackでresolve/rejectする。entryエラーもextractorのdestroyへ伝える。早期closeを従来のerrorイベントだけに依存せず処理する構造になった。
- 4つのprefixとMapの対応、最初の`./`だけ除く正規化、`worker/index.js`の特別処理、空名/末尾slashの除外、重複の後勝ち、非file/未知bucketの無視を前後比較。hash算法、戻り値の型、exportは未変更。
- `packages/update-engine/src/index.ts:181–199`、installer `steps/release-bundle.ts:93–109`、`commands/update.ts:758–778`を確認。consumerは新しいReadableを渡してawaitし、その後に整合性確認を行う。入力を再利用する契約は確認したcallerにない。例外時に後続applyへ進める変更もない。
- 追加テストは早期closeのsettlementとgzip失敗時input.destroyedを明示的に検査。characterizationは4bucket、入れ子、重複、正規化、未知path/symlinkを確認。既存正常hashテストを削除・弱化していない。
- `metrics.json`の49→26行、bucket判定4→1はsourceと整合。毎entryの配列生成は追加されるため、性能改善とは判断しない。
- 判定: 静的問題なし。先行snapshotの231 tests成功を最終Iの実行結果へ転用しない。

### WA01: Honoと認証・policyのpath表現

- `auth.ts:294,367`、generic guard `:83,190`、platform admin auth `:167`の5箇所が`c.req.path`へ統一された。認証方式、tenant解決、CSRF、password-change制約、method-aware public例外そのものは変更されていない。
- 実際に導入されたHono4.13.5 `dist/utils/url.js:68–89`のgetPath、`hono-base.js:282–286`の同じpathをrouter.match/Contextへ渡す処理、request.pathへの保存を静的照合。独自decode実装を追加せず、ルーティングされたpathとpolicy判断が一致する。
- `index.ts:254–280`のmiddleware順序を確認。tenant-boundaryのaccount/friend/scenario/rich-menu判断は既に`c.req.path`を使用しており、認証で付いたtenant identityをその後のguardが利用する。薬局account guard/実routeの認可を外していない。
- 公開formはGETのみの例外を保持しPUT/DELETEは認証へ進む。platform-adminの別session、CSRF、no-store、ログイン例外を保持。settings Bearer bridgeは既存のmethod-aware coverageを引き続き利用する。
- 新規テストはprefix/segmentのencoded aliases、認証済みtenant identity、public formのread/mutation差、real worker template routeのDB未到達401、platform login/session/no-store、薬局allowlist/QR禁止を検査する。テスト内容を読んだが、このreviewで実行していない。
- 判定: 静的問題なし。認証境界に関わる修正のため動的検証未完は受入阻害事項として残る。全public/LIFF routeの個別認証を網羅したとは主張しない。

### CL01: SDK scenarioを全step成功後に有効化

- `workflows.ts:22–41`は既存公開署名、step順/内容/parseDelay、成功時getの返却値を維持。createに`isActive:false`、全step await後にupdate trueを追加し、例外はそのまま伝播する。途中失敗時に削除を追加していない。
- `resources/scenarios.ts`のcreate/update/get payload、Worker `routes/messaging/scenarios.ts:227–300`のcamelCase入力、DB `scenarios.ts:153–235`のactive保存を確認。このisActive入力はBにも既存であり、新しいWorker契約を要求する変更ではない。
- Worker `routes/integrations/webhook.ts:635–650`はfriend_addで`scenario.is_active`を確認してからenroll/immediate deliveryへ進む。SDKでinactive作成する変更が実consumerへ届く構造を確認。
- 回帰はcreate false、全step後activate、activate後get、途中step失敗で部分step保持/非active/activate未実施、activation例外時get未実施を検査。空stepsは従来どおり最終activeになる構造を保持する。
- 判定: 静的問題なし。activation要求がサーバーで成功した後に応答だけ失われた場合まで「必ずinactive」と保証する変更ではないが、その時点ではstep構築は完了しており本修正の部分構築問題とは別。不要なrollbackを足す理由にはしない。

### WA02: LINE retryのrequest ID相関

- `client.ts:15–18,111–136`。private helperでaccepted-request-idを優先し、無ければ従来request-id/nullへfallbackする。broadcast/multicastのexport、引数、送信URL/body/headers、返却shape、409 retryAccepted処理を保持。
- Worker `services/broadcast.ts:440–442`がrequestIdを保存し、`services/insight-fetcher.ts:30–33`が保存したIDでinsightを取得するconsumerを確認。誤ったretry attempt IDを記録する原因へ変更が直接届く。
- 追加テストは2 methods×5 casesで200、409両header、acceptedのみ、requestのみ、どちらも無しを検査。通常成功・fallbackの期待値を含む。LINE一次仕様については担当記録の参照を読んだが、独立reviewで外部へ再アクセスしていない。
- 判定: 静的問題なし。LINE SDKの動的回帰・consumer smokeは未実施。

### CL02: 受付ごとの臨床下書きと詳細応答

- component `:294–295,604–653`。draft ownerが変わる時にsale/mismatchを初期化し、同受付のrefresh時は入力を維持する。取得済みcounter/saleを開始時に消し、旧患者の表示が新患者詳細に残る期間をなくす。
- detailsの各await後とerror/finallyはgeneration+account一致で絞る。全体load/queue refresh/account effect/cleanupでgenerationを無効化する。古い詳細応答が別のdetail世代へ書き込む構造ではない。既存のbusyによる直列化も維持。
- `confirmSection:656–679`と`submitSale:682–714`はselectedDetail.id一致を確認する既存制御を保持。submit payloadのexpectedVersionはselectedDetail.versionを使用する。臨床欄は全てreset対象のsaleDraft/mismatchDraftsを参照する。既存arrayを破壊的に編集していない。
- Web API `api.ts:244–283`とWorker EC routes `:504–625`を照合。受付ID/API path/payloadは変更されず、Worker staffScope/account scope/権限/expectedVersionの契約を変更していない。医療判断や販売要件の新規自動判定はない。
- 追加E2EはA編集→同A refresh保持→Bの確認取得待ち中にAの入力/確認表示を残さない→B確認・販売の送信payloadを検査する。409合成応答を返すため実販売成功や永続化を検証したテストではない。
- 判定: 静的問題なし。旧世代応答の到着順とerror/finallyの競合はコードを追ったが、独立実行検証はできていない。

## findings / 有限な残件

新規CONFIRMED_BUG、契約破壊、blocking source finding: **0件**。これは欠陥が存在しない保証ではない。以下を新規脆弱性やseverity付きfindingとして扱わない。

| ID | 分類 | 根拠と必要な確認 |
|---|---|---|
| IR-V01 | NEEDS_VALIDATION / 既存受入blocker | WA01/WA02は追加回帰が未実行。OS隔離条件が満たされた環境でB+test-only RedとI Green、認証/tenant/public method/CSRF/LINE consumerを確認する。 |
| IR-V02 | 有限なcoverage gap / 非blocking source concern | CL02 E2EはBの応答を遅らせるが、Aの古い応答をaccount/詳細世代の変更後に解放するケースは作っていない（e2e `:70–73,96–119`）。新規generation保護について、破棄済み世代のdetail/counter/sale/error/finallyが後着する順序を合成fixtureで確認するとよい。現在のコード上の誤対象保存は発見していない。 |
| IR-V03 | NEEDS_VALIDATION / 最終統合・配布 | 最終Iの統合suite/build/typecheck/package import smoke、CI想定Node22との実行差が未確認。以前のPASSをIへ読み替えない。 |

Worker型75診断と既存ARIA lintは今回のsource findingではない。型診断はログを独立に比較し、Bと後続packet前snapshotで件数75/75・内容完全一致と確認。ARIAについては担当者のB/W比較記録を参照し、独立実行はしていない。

## 独立レビューで実施した確認

- Git B→Iの14ファイル差分をread-onlyで確認。`git diff --check B I`: exit 0。
- IのHEAD/tree/source差分を再確認。対象sourceにreview中変更なし。
- source、関連caller/consumer、追加回帰テストを直接読取り。公開schema/migration/package manifest/dependencyの変更なし、既存テストの削除/skip/弱化なし。
- trusted parent-side Pythonで既存ログの集計・文字列比較のみ実施（targetコードimport/実行なし）。`workspace-tests.log`の合計は517 files / 4436 tests、型ログのTS診断75件はB比較と完全一致。
- 参照証拠: `worker-audit.md`、`client-audit.md`、`metrics.json`、`typecheck.log`、`baseline-worker-typecheck.log`、`workspace-tests.log`、integration内 `docs/pharmacy/evidence/audit-v5-20260928.md`。

## 実行済み記録の適用範囲

| 記録 | snapshot / 適用範囲 | このreviewでの扱い |
|---|---|---|
| update-engine 231、全workspace 517 files / 4436 tests成功 | F01+R01段階 | ログ集計を照合。後続WA/CL変更へ適用しない。 |
| SDK 58 tests、typecheck/build成功、修正前3失敗 | CL01局所W | 担当記録を参照。最終IのSDK/Worker統合成功とはしない。 |
| CL02 browser Red→Green 1 test、EC 10 tests、web型成功 | CL02局所W | 担当記録とtest内容を照合。実患者/実Worker/全画面検証とはしない。 |
| WA01/WA02 | sandbox起動失敗、target未到達 | 未実行。PASS扱い不可。 |
| Bの型診断との一致 | B対後続packet前snapshot | 元からの型問題の根拠。最終I型成功とはしない。 |
| source.patchのclean B再適用tree一致 | 親からの記録 | 統合内容再現の証拠。test/build成功とは別。 |

## 未実施・再開条件

`/Users/yusuke/.codex/skills/security-audit/SKILL.md` のUniversal execution safetyは、OS強制network遮断、allowlist環境、read-only target/toolchain、scratch限定書込み、資源上限を要求し、`If every control cannot be enforced, do not execute target code`と定める。委譲元がsandbox-execでecho/nodeもexit134となると記録しており、今回のreviewはこの条件を迂回しなかった。独立review内のtargetテスト/build/browser実行数は0。

再開には上記条件を満たす利用可能な実行環境が必要。基準Bと固定Iを照合したうえで、WA01/WA02のRed→Greenと最終Iの必要な関連/統合/配布確認を実施する。CL02について破棄済み世代の後着応答を検証する場合も合成dataだけを用いる。新たなsource修復を採用した場合は、新Iを固定し影響範囲のテストと独立レビューを更新する。

最終判定は**採択sourceの静的レビュー完了、動的受入BLOCKED、広範監査PARTIAL**。merge/push/deploy/本番承認は付与しない。
