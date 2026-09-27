# AUDIT-20260922 受入台帳

状態: RUNNING。全体Goalは未完了。

## 基準と境界

- H = B = `f62b90acd41154ab07c27f13b89a70ecb0eaa452`、`dev`。開始時index/作業ツリー/untrackedは空。
- owner: primary `/root`。worktree: `/Users/yusuke/workspace/pharmacy-harness-line`。
- P/W/Iは各packetで記録。既存差分なし。HEADを変更するまではBをGitから再現可能。
- ローカル実装・合成検証・今回差分のcommitのみ。push/PR/deploy/本番・実データ/秘密情報アクセスは対象外。
- runtime: Node 26.6.0 / pnpm 11.25.0。CI Node 22との差は検証時に記録する。
- `baseline.json`は追跡ソース・テストのpath/hash/行数一覧。生成物・依存物・秘密設定・実データを含めない。列挙はレビュー完了を意味しない。
- `.devin/wiki.md`の概要を参照、正本はコードと契約文書。
- install/build/test script確認済み範囲: root/package manifests、worker/root/db vitest、worker vite、CI verify。個別実行の前に残る設定と接続先を確認する。
- security-audit skillの隔離推奨より、今回明示されたローカル検証許可・直列実行境界を優先。OS sandbox保証を主張しない。外部実データ接続のある操作は実行しない。

## Coverage

2026-09-22再照合: `coverage-reconciliation-F42.json`。HEAD `07f131c`、125 module/1,268 pathの割当漏れ・重複なし。これは列挙の確認で、全体PARTIALを維持する。F32–F42の詳細は各result記録、現在位置は`checkpoint-F42.json`を参照。F39–F42では実D1候補選択、保留日時、作成日時、精度境界を修復し、R2/本番操作は未実施。

|領域|状態|確認/残項目|
|---|---|---|
|C01 設計・保守|PARTIAL|679 source files / 168502 LOCのbaseline。R01で同義エラーpolicy統合済。全module責務/依存は未完|
|C02 業務正確性|PARTIAL|F12/F19 Meet、F22–F26通知状態/期限の修復と回帰。全業務/日時/金額は未完|
|C03 永続化|PARTIAL|F08/F14 recovery CAS、F12 Meet冪等、F20/F21/F24キュー、F23未知結果保全。全保存/削除は未完|
|C04 migration|PARTIAL|F01/F05/F07と加算027–029、旧schema互換/SQLite/nativeD1検証済。全upgrade/failure経路は未完|
|C05 security|PARTIAL|auth調査、F16/F17/F31のresource scope、通知直前scope確認。全入口認可は未完|
|C06 privacy|PARTIAL|F02/R01/F29の上流error非漏洩、F27主体別draft分離。暗号/URL/storage全体は未完|
|C07 契約|PARTIAL|F02/R01 SDK、F06 CLI、F13/F15 body、通知旧schema/旧caller確認。全公開契約は未完|
|C08 UI/UX|PARTIAL|F03/F04/F27の二重操作/復旧/主体別draftをChromium検証。Web/LIFF全体は未完|
|C09 性能・資源|PARTIAL|F13/F15 body上限、F20/F21/F24 queue測定。restore計算量/tokenrefresh懸念記録、全hotspot未完|
|C10 信頼性|PARTIAL|F08/F14復旧競合、F09/F23結果不明、F19–F26 cron進行性/再開、F30 template準備gate。全webhook/cron未完|
|C11 テスト|PARTIAL|baseline verify:ci PASS、採択packetのRED/GREEN記録済。最終統合/全体coverage未完|
|C12 build/tooling|PARTIAL|各packet verify:ci/build証拠あり。Node26実行、CI Node22未実行、全tooling未完|
|X01 配布・稼働基盤|PARTIAL|Worker compiled入口/nativeD1、CLI/SDK pack検証済。F-DIST-01 migration完全性未解決|
|X02 供給網・ライセンス|PARTIAL|pnpm lock/allowBuilds/CI pinと権限を確認中|
|X03 データの生涯|PARTIAL|incoming-image immutableR2/retention tombstone、recovery lease/fence調査済。全DSR/restore未完|
|X04 外部連携・取込|PARTIAL|LINE unknown/再送、Meet冪等、webhookbody/referral scope調査。全consumer/署名経路未完、本番除外|
|X05 端末・offline/native|PARTIAL|Web/LIFF storage・複数tabを対象、native/FFIの有無確認待ち|
|X06 AI/agent/MCP|PARTIAL|F09 broadcast unknown、F10 scenario activation修復とcompiledstdio検証。残tool境界未完|
|X07 医療・算定・金銭|PARTIAL|処方期限/継続相談/服薬後通知の既存契約回帰。全医療経路は未完、制度/医療期間変更なし|
|X08 公開Web|PARTIAL|F17/F18 tracked-link修復、OG HTML/resolver module確認済。public-preview-review.md参照。全公開経路未完|

## 有限packetキュー

### F01 — SQL安全チェッカーの字句認識 (FIX / P2 / CONFIRMED_BUG)

- 状態: VERIFIED。owner primary、P=B (対象2ファイルは開始時のまま)。
- 書込範囲: `scripts/check-migrations.ts`, `scripts/check-migrations.test.ts`。
- 読取り依存: CONTRIBUTING.md Backward-Compatible Update Policy、update-engine migration scanner。先行packetなし。
- 根拠: `stripLineComments`が文字列中の`--`以降を削除、`DROP/*comment*/TABLE`はregexに一致しない。CIの非破壊DDLゲートをすり抜ける。
- 保持契約: export/signature/CLI/終了値/既存migration/cutoffは維持。意図的差分はコメント・文字列をSQLとして区別し、危険DDLを検出、文字列内のDDL語句で誤拒否しない。
- 検証: 追加回帰テストの修正前RED→修正後GREEN、既存26 tests、全post-baseline SQL checker、CLIの合成SQL終了値。
- 到達条件: 引用符・escaped quote・コメント・空白を含む危険SQLの検出、正常SQLは許可。未閉鎖quote/commentは安全停止。
- 検証結果: 修正前47 tests中17 FAIL/30 PASS (exit 1)、修正後47 PASS (exit 0)、現行25 migrations PASS、旧CLI正常/既存拒否ケースはstdout/stderr/exit byte同一、新規見逃しケースのみexit 0→1。
- W: `F01-snapshot.json`。I=dev、checkpoint `9d38616`。統合注意点: migration/API/exports不変、既存26 testsを削除せず21追加。
- 未実施: 最終独立レビュー/統合後全検証は後段。単体scriptでmodule/export/package/asset変更なしのためF01固有の配布物検証は非該当。
- 再発防止: 引用符内のコメント記号→単純行切断によるDDL見逃し→21 lexical回帰ケース→SQL tokenとquoted contentsを区別。


### F02 — LINE SDKエラー本文のログ流出防止 (FIX / P2 / CONFIRMED_BUG)

- 状態: VERIFIED。owner primary、P=`9d38616`（対象コードはBと同一）。
- 書込範囲: `packages/line-sdk/src/client.ts`, `packages/line-sdk/test/client.test.ts`, `apps/worker/src/services/line-proxy-send.ts`, 同test。呼出し追跡で同根のproxy本文転載を確認し範囲へ追加。
- 根拠: `lineApiError`がJSON `message/error`を200文字までErrorへ転載→`services/auto-reply.ts:165–177`のreply/catchなどが例外をconsoleへ出力。低信頼の上流本文がログ境界を越える。実患者データ流出の発生は未確認。
- 期待契約: packages/AGENTSの「エラーメッセージに上流レスポンス本文を含めない」、rootのPHI/PII/secret保護。
- 保持: public methods/signatures、HTTP status判別、成功body、409 retryAccepted、404 default-menu nullを維持。意図的差分: エラーbodyの任意message/errorを省略。完全一致する既知のInvalid reply tokenだけ固定literalへ変換し、step-deliveryの決定的拒否判定を維持。既存文言assertは維持。
- 検証: synthetic PHI sentinelで修正前RED→GREEN、全line-sdk tests/typecheck/build、呼出し側auto-reply/送信系回帰。package export変更なし。生成distからisolated import/smokeも実施。
- 到達条件: 3つのerror入口(request/default-menu/upload)でbody非漏洩、成功・冪等・404分岐保全。
- 検証結果: SDK修正前2 FAIL/6 PASS、proxy修正前3 FAIL/5 PASS。修正後SDK 8 tests、Worker近傍7 files/154 tests、SDK/Worker typecheck、SDK buildすべてexit 0。`F02-green.log`参照。
- 配布物: pnpm packのcompiled distとmanifestのみをtempへ展開し、元src無しでESM import/exports/成功message helper/エラー非漏洩/既知拒否判定をfetch stubでsmoke。exit 0、収録一覧/hashは`F02-package.json`。
- W: `F02-snapshot.json`。I=dev、checkpoint `5565f85`。未解決: 最終独立レビュー/統合全検証は後段。先行依存なし。
- 再発防止: 上流body message/errorに機微文字列→200文字切詰めでもログ漏洩→3 error入口とproxy回帰→固定allowlist literalのみ出力。実データアクセスなし。

### F03 — 服薬後回答の送信ロック (FIX / P2 / CONFIRMED_BUG)

- 状態: VERIFIED。owner primary、P=`5565f85`。書込範囲: LIFF MedicationFollowUpPageと同test、e2e/medication-followup-submit.e2e.ts。
- 根拠: 単一busyIdを別行送信が上書きし、最初の未完了行が再度有効になる。finallyも残る操作を解除。handler内guardなし。DB二重保存はCASに依存し未断定。
- 契約/差分: 送信結果・API/version/idempotency payload・確認ダイアログ・患者表示を維持。画面全体で一度に1つの回答送信とし、完了/失敗時に解除。refで再render前の再入も防ぐ。
- 検証: 合成2行の保留POSTを使うChromium挙動RED/GREEN、成功/失敗から次行送信、nearby vitest/typecheck。source文字列assertだけを証明にしない。
- 到達条件: 進行中に全送信ボタンdisabled、追加POSTなし、settle後回復。未実施: 最終統合/独立レビュー。
- 検証結果: Chromium修正前2 FAIL→修正後2 PASS、focused Vitest 5 PASS、LIFF tsc --noEmit PASS。合成API/LIFF mock、loopbackのみ。既存Vite設定を読みtemp envDirで秘密.envの読込みを回避した一時Playwright設定。
- W: `F03-snapshot.json`。I=dev、checkpoint `42454a9`。source assertionは全体ロックの期待へ変更し、実browser regressionを追加。先行依存なし。

### F04 — 患者別アンケート/access読込み失敗の画面内復旧 (FIX / P2 / CONFIRMED_BUG)

- 状態: VERIFIED。P=`42454a9`、owner primary。対象: PatientIntakePage.tsxと患者読込みbrowser regression。
- 根拠: selectedIdだけのeffect、同じ患者選択early return、onlineではlist/policyだけ再取得するため一過性失敗から復旧しない。access失敗を読み込み中と表示。親が両effectとreconnect/select/UI経路を照合。
- 保持契約: 患者scope/旧応答破棄/未送信入力/同意/送信key/payload/APIを維持。意図的差分: 失敗したreadだけを手動・onlineで再試行し、access失敗をloadingと区別。正常な編集状態の無条件再取得やmutation自動再送は行わない。
- 検証: Chromiumでintake/access一時失敗→手動retry、未送信入力保全、online retryとPOST無し、患者切替中の旧応答破棄。nearby tests/typecheck。
- 検証結果: 修正前Pを別一時moduleへ取り出し、同じブラウザtestで4 FAILを確認（元作業ツリーは戻さない）。修正後新規4＋既存profile-version 1=5 PASS、focused Vitest21 PASS、LIFF tsc PASS。`F04-browser-red-corrected.log`/`F04-green.log`。storage書込み失敗でも未送信回答保持、online時mutation無し、患者Bへ切替後にA応答が届いてもB内容/版を維持。
- 初回harnessの非表示radio直接click timeoutはアプリ不具合証拠にしない。可視label clickへ修正後、Pを再検証してREDを取得。
- 到達条件達成: ページreloadなしで復旧、旧患者/旧responseを混ぜない。W=`F04-snapshot.json`、I=dev、checkpoint `6a35d2e`。最終統合/独立レビューは後段。
- 再発防止: 初回一時失敗→selectedId不変でeffect再実行なし→手動/onlineのbrowser回帰→失敗read専用retryと入力保持、active cleanupで旧response破棄。

### R01 — LINEエラー規約の重複解消 (REFACTOR / P3)

- 状態: VERIFIED、P=`6a35d2e`、owner primary。F02で同じprivacy/retry policyがSDKとproxyに2実装あり、同じ欠陥を両方修正する必要があった実績に基づいて採択。
- 対象: line-sdk client/index、新errors.ts、Worker line-proxy-send。書込はこの4ファイル。読み依存はF02回帰と送信consumer。
- 保持契約: F02のHTTP status/固定Invalid reply token/成功/409/404契約、async Error生成とpropagation、既存exportを保つ。追加export `createLineApiError`のみ。共有可変stateなし。
- 改善指標: 同義policy実装数2→1。対象4ファイル（新設含む）の総LOCも前後計測、LOC自体はノルマにしない。
- 保全指標: dist JS/gzipを同じ集計法で計測しgzip増分<=1KiB、import時network/storage副作用なし、依存循環なし。性能向上は主張しない。baseline `R01-before.json`。
- 検証: SDK/Worker近傍tests/typecheck、SDK build/pack後の元srcなしexport/import/error smoke。Worker統合buildの成果物確認は最終Iで実施。
- 結果: policy実装2→1、固定対象総LOC 523→516、dist concat gzip 3985→4038 bytes（事前の増分1KiB以内）。性能向上は未測定・主張なし。
- SDK8 tests/Worker近傍154 tests/両typecheck/build PASS。packed distのみのimport/export全旧symbol＋追加1の構造比較、re-export object identity、import副作用なし、固定分類/非漏洩smoke PASS。`R01-checks.log`, `R01-after.json`にコマンド/exit/hash/収録一覧。
- W=`R01-after.json`、I=dev、checkpoint `9b98253`。Worker最終build/独立レビューは後段。例外catch/cleanup/送信副作用の移動なし、async helperへの同一転送のみ。

## 検証・独立レビュー

- baseline `pnpm verify:ci`: exit 0。Node 26.6.0、許可した環境変数のみ、合成fixture。共有build→workspace typecheck/test→scripts 23 files/225 tests→25 migrations PASS。対象実効ソースB（台帳のみ追加）。詳細 `baseline-verify.log`。

最終独立レビューは未実施。最終I固定後にfresh-context read-only reviewerを1体使用する。ソース変更中に最終レビューを依頼しない。

## 再開

Git状態と本台帳を照合し、未完の調査・packetだけ続行する。全体監査、採択修復・改善、統合検証、独立レビュー、再探索を満たすまで完了にしない。


### F06 — setup Admin展開先の包含検証 (FIX / P2)

- 状態: ADOPTED。P=`9b98253`。owner primary。対象はcreate-line-harness deploy-adminと新しい挙動test。
- 根拠: tar parserは`admin/../outside`をMapへ保持し、materializeも保持、stageAdminFilesはjoinのみで一時dir外へ書込む。整合するmanifest hashを持つ不正bundleが条件。通常bundle単体改ざんのhash回避は主張しない。
- 保持契約: 正常nested assets、置換、binary bytes、wrangler引数、戻りURLを維持。不正相対pathのみ書込み前拒否。公開型/exportsの変更なし。
- 到達条件: 全path事前検証、POSIX/Windows絶対path・親成分・backslash拒否、正常nested assetsとstage cleanup維持。
- 検証計画: tmpdirをrepo配下の使い捨てdirへ置換し、wrangler/repoPnpmをstub。修正前RED→GREEN、正常展開とcleanup、typecheck/buildとcompiled CLI smoke。外部操作なし。

- 結果: 既存コードで8 FAIL/1 PASS、修正後10 PASS（cleanup追加）。CLI typecheck/build PASS。生成distとmanifestをrepo配下tempへ複製し、installed依存のみ接続、元package sourceなしで `node dist/index.js --repair-admin` の引数検証を実行。期待exit1/日本語usageを確認、外部接続/設定dir生成なし。`F06-red.log`, `F06-green.log`, `F06-artifact.json`。
- W/I: `375cf15`、`F06-snapshot.json`。状態VERIFIED。最終統合/独立レビューは未実施。新規dependency/公開export変更なし。stage中失敗のtemp cleanupも実装。

### 保留・次packet候補

- F05: bootstrap generatorの改行区切りsplitが通常の複数行CREATE TRIGGERを分断。合成SQLite直接exec成功、同じSQLをコピーしたgeneratorへ追加するとincomplete input、`F05-reproduction.json`。修復前。既存migrationは変更しない。
- F-DIST-01: bundle migration bytesがcomponent hash対象外。source metadataのmigration_digestsを流用できる根拠はないため初回子報告のその根拠は撤回。旧OSS manifestの互換契約と信頼できる旧artifact digest補完方法が未確定。修復・完全性保証は未実施。`distribution-investigation.md`。
- C-DIST-03: tar展開のentry数/bytes制限なし。過大入力実測・適切な互換上限は未確認。
- C-DIST-04: clone-repo frozen install失敗から通常installへ無条件fallback。依存変更が生じた証拠はなし。


### F05 — bootstrap生成時のSQL文境界 (FIX / P2)

- 状態ADOPTED、P=`375cf15`。対象generator、新ローカルsplitter、bootstrap testと合成generator回帰。
- 根拠: F05-reproduction.json。複数行trigger内semicolonを文終端と誤認。期待は有効な追加SQLite migrationをbootstrapへ再現すること。
- 保持: 現行生成SQL/meta/baseline bytes不変、benign duplicate skip、既存migration不変。新dependencyなし。DDL安全policyは既存checkerに残す。
- 設計: 引用符/comment内semicolonを無視。CREATE TRIGGERの内部文は保持し、内部semicolonに続くENDをtrigger終端として扱う。SQLite自身が構文を検証。generatorとreplay testの同義regexをローカルmjsへ集約する。
- 検証: コピーしたgeneratorに合成migration（multiline trigger/string/comments/CASE）を追加して使い捨てDBで実挙動、既存bootstrap再生成比較、db tests/typecheck。元generatorのdefault書込みは実行しない。

- F05結果: VERIFIED、W/I=`d8eb36c`。DB全100 files/474 tests PASS、db typecheck PASS、generator --check PASS。baseline/bootstrap/meta生成物と既存migrationの変更なし。SQL生成→使い捨てSQLiteでtrigger2行とCASE/quote/comment/後続indexを実検証。新helperはrepo-local generator/test用、npm公開file list変更なし。初回stdout PIPE検証で出力切断が別途判明したため、F05挙動検証は同期file FD出力で分離。F07として別採択。最終独立レビュー/統合未実施。

### F07 — bootstrap --stdoutの出力切断 (FIX / P2)

- 状態ADOPTED、P=`d8eb36c`。対象generator/stdout回帰。
- 根拠: stdout.write直後process.exitで非同期pipe出力が切断、合成生成SQLのSQLite replayがunrecognized tokenで失敗。通常file FD出力では成功。
- 保持: 出力SQL bytes/exit0/--check/default挙動を維持。書込み完了後に終了させる。新dependencyなし。
- 到達条件: PIPEで全SQL bytesがbootstrap.sqlと一致しSQLiteへ読込可能。RED/GREEN、generator --check。元repoの生成物書込みなし。

- F07結果: VERIFIED、W/I=`a96aa8158a88f296237e068c5f8ba67ab3abb1a2`。PIPE完全一致test RED→GREEN、近傍13 tests PASS、generator --check PASS。同期FD書込みの試行は非blocking pipeでEAGAINとなったため採用せず、stdout callback完了をawaitする最終実装。全出力bytesは現行bootstrap.sqlと一致。最終独立レビュー/統合は未実施。


### F08 — recovery進捗・完了の競合保全 (FIX / P2)

- 状態RUNNING、P=`a96aa81`、owner primary。対象recovery operationsとtest、consumer data-protection-routesとtest。
- 根拠: child記録recovery-investigation.mdを親が原典照合。進捗read後、別batchのcommitをUPDATE時に検出せずcount/cursorが後退する。completeもread後のcount/fence変更を検出せず、失敗した完了UPDATEでもfence解放が独立実行される。
- 契約: scope/proof/承認者実行者分離/単調進捗/同batch逐次再送/既存API payload/保存形式を維持。意図差分は競合・expired fenceを原子的に拒否し、競合したrequestが正常進行中operationをfailedにしない。
- 検証: SQLite実UPDATE前の順序を制御し進捗後退・fence失効・complete競合をRED/GREEN。旧同batch再送とscope拒否、route競合応答、近傍retention/intake tests/typecheck。実D1/R2・本番操作なし。
- 到達: 更新時snapshot/fenceを照合、失敗完了でactive fenceを誤解放しない。合成実DB状態assertを使いmock成功だけを根拠にしない。公開export削除/DB migrationなし。

- F08結果: VERIFIED、W/I=`376e4a0`。SQLite競合再現は4 FAIL/11 PASS→最終近傍9files105tests PASS。Worker typecheck PASS（最後の変更はSQL時刻判定/対応bindingのみ）。read後に変わった進捗/期限をmutation内で拒否、DBの実行時刻で期限照合、失敗completeではfenceを解放しない。
- consumerは保存済みlastBatchIdを計算元として渡す（内部入力へoptional field追加、旧caller省略可能）。別requestの成功後に同数count/古cursorで来ても409、同batch同payload再送は保持。競合409でoperationをfailedへ変更しない。
- `F08-red.log`, `F08-focused.log`, `F08-final.log`, `F08-snapshot.json`。既存テスト/公開route/payload/schema削除なし。Worker build成果物・実D1 engine・最終独立レビュー/統合は未実施。

### F09 — MCP送信結果不明時のbroadcast保全 (FIX / P2)

- 状態RUNNING、P=`376e4a0`、owner primary。対象MCP broadcast tool/test。読み依存SDK broadcast/http、Worker send-segment/delete、DB queue（子記録mcp-investigation.md、親原典照合）。
- 根拠: segment送信はDB queuecommit→202、応答喪失でthrow→MCPがbroadcastをdeleteしqueue/監査記録を消す。
- 保持: tool名/Zod入力/成功JSON/送信引数/予約/既存error fieldとisErrorを維持。意図差分: 送信開始後は自動削除せず、既知broadcastIdと結果unknown/状態確認案内を付加。通常sendも同じ結果不明の通知を持つ。新dependencyなし。
- 検証: 合成transportでqueue保存後reject、削除/再送なしとIDをassert。成功/予約/入力拒否/作成失敗を保全、MCP全tests/typecheck/build、compiled stdio toolのloopback smoke。外部LINE/本番接続なし。
- 到達: 応答喪失でqueueを壊さず、利用者が既知IDで状態を照合できる。配信完了を装わない。

- F09結果: VERIFIED、W/I=`72fdd26`。修正前segment記録削除をassertで検出、全3targetの結果不明情報不足を含め3 FAIL/5 PASS→MCP全7files32tests PASS。MCP typecheck/build PASS。tool登録/schema部分はP/W byte一致、成功JSONはbyte assert。送信例外catchの削除cleanupだけを廃止し、外側error応答へ伝播。
- 配布物: compiled dist/manifestと全runtime依存をrepo配下のtempへ実体コピー（SDKはdistのみ）。全symlinkがtemp内で閉じることを確認、元repo/source/node_modulesへの参照なし。stdio initialize→tools/list→broadcast callを実行、loopback APIのqueue保存後HTTP切断でも2 POSTのみ・delete/retryなし・記録sending保持、ID/unknown応答PASS。artifact hash/schema/dependenciesは`F09-artifact.json`、再現scriptは`F09-artifact-smoke.mjs`。
- 薬局到達境界: indexのpharmacyTenantApiAllowlistGuard→generic-feature-guardの許可prefixにはbroadcastなし、disabled prefixにはbroadcastあり。薬局tenant通常経路で拒否する設計であり、本番薬局到達/被害は主張しない。generic packageの確定欠陥として修正。
- 最終統合/独立レビュー未実施。`F09-red.log`, `F09-green.log`, `F09-snapshot.json`。API route/DBschema変更なし。


### 次に検証する確定候補

- F-MCP-04: create_scenarioのstep応答喪失で作成済scenarioをdelete。親は原典照合済み、修復/合成再現待ち。部分作成を残す場合はinactive組立が必要だが、現Workercreateはis_active=1/line_account_id未設定でINSERTしてから別UPDATEなので、DBhelperのoptional isActive/lineAccountIdをINSERTへ移す一貫した修復を検討する。既存default active・公開inputと最終正常出力は保持。`mcp-remainder-investigation.md`。
- C-MCP-05: create_formの公開accountId引数が無視される。domainがtenant共通かの契約照合待ち。
- crypto-utilsとplatform-admin/auth.tsを親が全文読取り。canonical base64url検証、GCM/HMAC導出、session token hash/credential version/staff active/bootstrap必須変更/idle cutoff/CSRF/no-store経路を確認。全caller/復号データscope/ログアウト競合は未確認。新欠陥断定なし。
- draftStorage.ts全文読取り。24hTTL/例外softfail/legacy firstclaim/liffId scopeを確認。新患者draftの認証subject間共有懸念は未解決、実データ/既存draft削除なし。

現在のcheckpoint: `72fdd26`。コード作業ツリーはclean、PLANSとevidenceのみ今回追加が未commit。最終I未固定、全領域PARTIAL、最終verify:ci/Worker成果物/独立review/再探索は未完。唯一の子thread /root/audit_db は調査完了、close APIがなくopen扱いで再利用中。fresh-context最終reviewは未実施。


### F10 — scenario組立と結果不明の保全 (FIX / P2)

- 状態RUNNING、P=`72fdd26`、owner primary。対象MCP create-scenario/test、DB scenario create/helper tests、Worker scenario create/route tests。根拠mcp-remainder-investigation.mdと親原典確認。
- 根本原因: 複数stepを公開済scenarioへ非原子的に追加し、応答不明時は全削除していた。安全に残すには組立中inactiveが必要。現serverのinactive/accountはINSERT後UPDATEで、途中active/global窓がある。
- 保持: 既存tool schema、成功出力、delay/順序、API既存fields、DBhelper旧callerのdefault active、scope認可、schemaを維持。意図差分: INSERT時からaccount/inactiveを反映し、MCPはinactiveで組立後activate。結果不明でdeleteせずID/確認済step数を返す。
- additive optional DB helper fieldsのみ、旧引数有効、migration追加/変更なし。新dependencyなし。
- 検証: firstINSERT時のSQLite状態、旧default、route入力転送/成功JSON、step応答喪失/activation応答喪失/成功/invaliddelayを合成transportでRED/GREEN。DB/Worker/MCP近傍・型・MCP生成配布物を検証。
- 到達: 組立途中にactiveや他account向けとして露出しない。未知のwrite結果を削除/再実行で破壊せず、照合に必要なIDを保持。

- F10結果: VERIFIED、W/I=`af9a082`。修正前DB1 FAIL/6 PASS、MCP3 FAIL/1 PASS、Worker1 FAIL/5 PASS→focused DB7/Worker6/MCP36 tests、3workspace型検査/build PASS。旧helper引数のactive/account-null defaultを実SQLiteで確認。初回INSERTからinactive/accountをassert。戻りlineAccountIdは実保存scopeを返す（従来の更新前null返却を修正）。
- MCP生成distと依存実体のみのisolated stdioでF09を再確認し、create_scenarioの最終step保存後にHTTP応答切断。2steps/非activeのscenario保持、delete/activate/retry無し、ID/confirmedStepCount=1/unknownを確認。`F10-artifact.json`/再現mjs。入力schema/登録はP/W byte同一、成功JSON保持。DBhelperはoptional field追加のみ、既存exports不変。Worker生成成果物は別途未実施。

## 統合検証 checkpoint af9a082

- `pnpm verify:ci` exit0、Node26.6.0/pnpm11.25.0、環境allowlist・合成fixture。入力は`integration-F10-input.json`、最終コードはF10-snapshotと同一（検証後の変更はcommit/台帳のみ）。
- 共有build、全workspace typecheck/test、scripts246tests、25migrations checker PASS。workspace tests: Worker2868、DB477、Web264、LIFF202、MCP36、installer80、update-engine228、SDK56、LINE SDK8。詳細`integration-F10-verify.log`。
- これは中間Iの統合check。ブラウザの既実施F03/F04は当該ソース不変で再利用可能。Worker配布物・残監査・独立レビュー・最終再探索は未完。Node22実行、外部CodeQL/依存脆弱性照会/本番固有検証は未実施。
- 現在コードは`af9a082`までローカルcommit済み。PLANS/evidenceは今回の未commit記録。開始時のユーザー差分はなく、push/PR/deploy/本番操作なし。


## Worker生成成果物の実行確認 (af9a082)

- `pnpm exec vite build --config vite.config.mts` exit0。元のVite plugin構成を合成wrangler設定/空envディレクトリで起動。DB/R2は合成名、metrics停止。本番接続なし。`worker-artifact-work.json`/`worker-artifact-build.log`。
- compiled Worker全JS chunksとclient assetsのみを別temporary directoryへ実体コピー。Miniflare 5のinstalled `convertV4MiniflareOptions`を使い、manifestにcompiled JS全件を列挙。runtimeに元srcやworkspace packageは参照させず、Miniflareを実行基盤として利用。SQLite complete_statementでbootstrapを分割し、local D1 prepared batchで投入（生成SQL変更なし）。
- `node worker-artifact-smoke.mjs <isolated-dist> <installed-wrangler>` exit0。未認証API401、薬局汎用scenario POST403かつDB作成0件、認証済み未割当staffのaccount一覧200/空配列、outbound呼出0を確認。`worker-artifact-runtime.json`にartifact bytes/SHA256と結果、再現mjsを保存。作業用build/runtime directoryは除去済み。
- harness失敗: Miniflare旧API→v4 converter、modulesRules非対応→明示modules、D1 exec multiline制約→prepared batchで是正。最初にscenario201を期待したが、pharmacy capability schema導入時には汎用機能を閉じる正式ガードのため403だった。ガードやschemaを弱めず、期待を現契約に修正。F10汎用scenario作成の実artifact経路は未実施であり、DB/route回帰およびMCP配布物検証と区別する。
- この結果はWorker起動/認証/DB読み取り/薬局ガードのartifact smokeであり、全API・本番Cloudflare・LINE送信の確認ではない。R01のLINE SDK export統合後にWorker成果物が起動することを確認。全監査/独立レビューは継続中。


## 供給網の追加確認と現在の残件

- pnpm-workspaceのallowBuildsはbetter-sqlite3/esbuild/workerd。workflowのusesは全て40桁commit固定。Repository Verifyはcontents read、CodeQL security-events write、非PRの別attest jobでid-token/attestations write。upstream更新はseller repo条件下のschedule/manualでdevからPR、contents/pull-requests write。実行・外部変更なし。
- `pnpm licenses list --prod --json` exit0、10 license groups、unknown/unlicensed groupなし。`licenses-local.json`/`licenses-local-result.json`。これはローカル依存metadataの検査であり、法的適合・全license本文同梱・現在の脆弱性不存在の証明ではない。F02の実packにはpackage/LICENSEが収録されていた。外部audit/CodeQL/SBOM/Node22は未実施。
- F-DIST-01追加調査はdistribution-investigation.mdに回収。汎用CLIの未検証SQL経路を確認、中央release workflowの現行到達経路とは区別。旧releaseの信頼できる期待digestは未解決。optional hashだけで解決済みにしない。
- checkpointはaf9a082。今回の追加作業は受入記録とartifact smokeのみ、製品コード変更なし。git diff --check PASS。31 code/test filesのB→HEAD差分（1094 additions/156 deletions）を確認、PLANS/evidenceのみ未commit。全C/X coverageはPARTIALのまま、fresh-context独立レビュー未実施。唯一の子threadは調査完了、close API無しでopen扱い。


### F11 — ログイン遷移先のURL正規化境界 (FIX / P2)

- P=af9a082、owner primary、対象apps/web/src/lib/safe-next-path.tsと同test、login browser回帰。書込み前treeはcode clean、既存PLANS/evidenceのみ。
- 根拠: helperはprefixのみ検査、LoginPageはnextをrouter.push/replaceへ渡す。installed Next app-router-instanceはnew URL(href,location.href)で解釈し外部遷移を許す。ASCII tab/newlineをslash間に含めるとURL parserで除去され、外部authorityになり得る。期待根拠はhelperコメントとapps/web AGENTSの同一origin相対path契約。合成browserで確定させる。
- 保持: helper export/signature、正常path/query/fragmentの戻り値、login UI/API認証を維持。意図差分: URL解釈後に外部originになる値、loginへ正規化される値は既存fallback /へ。dependency/schema変更なし。
- 検証: URLSearchParams経由のcontrol文字、既存正常/拒否、実buildのloginから外部navを捕捉するbrowser RED/GREEN、Web tests/typecheck/build。外部通信は遮断、合成sessionのみ。


- F11結果: VERIFIED/ローカル統合、commit `dabec00`。helper回帰は修正前2 FAIL/2 PASS。修正前Next生成配布物のChromiumログインから `http://evil.example/` 遷移を検出（通信はrouteでローカル応答）。修正後はcontrol文字を拒否し、URL解釈後origin/login pathを検査。parser用固定originと同じhostを指定する回避も拒否。
- Web全55files267tests/typecheck/build PASS。最終compiled static exportをloopbackで配信し、外部next2ケース拒否・正常/settings query/fragment保持のChromium3tests PASS。既存helper exports/signature/通常戻り値/既存2testsは維持、3unit testsと3browser cases追加。`F11-red.log`, `F11-browser-red.log`, `F11-green.log`, `F11-build.log`, `F11-browser-green.log`, `F11-artifact.json`, `F11-snapshot.json`。
- harness調整: 最初のstatic serverは/login directoryを優先しdirectory listing→html優先に修正後、実欠陥REDを取得。LIFF runnerのgrep stringをCLI --grepへ訂正。アプリのassertion/認証を緩和していない。途中修復に対する2browser PASS後、control拒否追加のためWeb tests/type/buildと最終3browserを再実行。
- このpacketで製品変更は3filesのみ。開始時ユーザー差分なし、追加台帳は未commit。hooksなし/core.hooksPath未設定を確認して局所commit。最終全体統合/独立レビューは未完、F10全体PASSはWeb変更前の結果として区別。

## Frontend配布物と公開プロフィール追加確認

- af9a082の追跡web/liffファイルを合成temp rootへコピー（.env/tsbuildinfo除外）、installed dependenciesのみ参照して各`pnpm run build` exit0。API/LIFF URLはexample.invalid、NEXT_TELEMETRY_DISABLED=1、固定build timestamp/sha。LIFF tsc+Vite、Web Next static export成功。識別情報`frontend-build-work.json`/`frontend-artifact-before.json`、build logs/result JSON。元src/.envをruntime serverから読まない。
- LIFF compiled distをloopback配信し、既存startup technical-detail-free browser test1件PASS（liffId無しの安全な起動失敗）。LIFF SDKの実認証/全画面はこのartifact testでは未実施。`liff-artifact-browser.log`。F03/F04の既実施browser回帰は不変コード結果を再利用。
- Worker/web/liffの生成build確認済み。hls等500kB超警告は記録、測定基準なしの分割は行わない。Web/LIFFの全ブラウザ経路確認とは区別。
- `public-profile-investigation.md`に子の限定静的調査を回収。18公開fieldの明示projection、LINE identity/account解決、管理owner/admin編集制約を確認。account.name fallbackの公開意図とpublic/always availableの意味は未確定、認証を変更しない。全auth/capability領域をREVIEWEDにはしない。
- temporary build/runtime serverは終了・除去済み。再現runnerとartifact hash/logは保存。現在HEAD `dabec00`、唯一の子は調査完了、close API無し。全体Goalは未完。


### F12 — 同一相談登録の並行再送で配送世代を保持 (FIX / P2)

- P=dabec0034837607330729392f35189fd584ed68c、owner primary、対象services/meet-consultation-reminders.ts/test。root/worker規約、既存db.batch atomicityと同日時再登録dedupeコメントを契約根拠とする。
- SELECT→batch間で同じ新規/変更登録が並行すると両方scheduleChanged扱いとなり、後続batchが先行配送済みreminderのdelivery_id/statusを初期化する懸念。SQLiteで2requestのread/writeを分離して再現する。
- 保持: route/exports/signature/返却JSON/既存DBschema、account認可、実日程変更時の新配送世代、前日/1時間前の計算を維持。変更: 世代変更判定を事前SELECTから同じatomic batch内の現行consultation比較へ移す。新dependency/migrationなし。
- 検証: 並行new/rescheduleの配送済み世代保持RED/GREEN、既存reschedule/旧claim拒否/rollback/tenant/sender、Worker型検査、必要consumer。外部送信なし。


- F12結果: VERIFIED/ローカル統合 `b0eb1bd`。修正前new/rescheduleの2競合test FAIL/既存18 PASS→修正後service21/route7/webinarconsumer6=34 PASS、Worker tsc PASS。`F12-red.log`, `F12-green.log`, `F12-final.log`, `F12-snapshot.json`。
- 同batch冒頭で現行consultationと入力を比較し、実変更されるkindだけをcancelledへ更新→consultation upsert→cancelled reminderのみ新generationで再作成。同payloadの後続batchは現行との差がなく、sent/processing/retry状態を維持。途中cancelled状態はtransaction外から見えず、後段失敗なら全rollback。obsolete kindの既存sentは従来どおり保持。別account conflictは一切変更なし。保存形式/公開exports/signature/route/正常返却の変更なし。
- 古い事前SELECT/内部専用row型はcaller確認後削除。旧batch[0]の相談変更数判定は追加statement後の[1]へ。既存18tests削除なし、並行2・rollback/foreign scope1を追加。公開関数変更は内部実装のみ、module/manifest/asset変更なしのためF12固有のpackage配布変更は無し。Worker成果物の最新I検証/最終統合/独立レビューは後段。
- 子の完全調査記録と親の日時/cron/確認通知/cancelの確認範囲はmeet-consultation-investigation.md。claim後と外部dispatchの間のcancel/reschedule、厳密ISO入力の契約は未確認として残す。通知停止の全競合解消を主張しない。
- HEAD b0eb1bd、コード作業treeはclean、PLANS/evidenceだけ未commit。外部送信/Google更新/本番DB/deploy/push無し。唯一子threadは調査完了・close機能無し。全C/XはまだPARTIALでGoal未完。


### F13 — 処方せん画像の実受信サイズ上限 (FIX / P2)

- P=b0eb1bde24a36f66c21a8d544d0f48d54047d047、primary。対象prescriptions image.ts/routes.tsと同tests。既存10MiB制限が期待契約。Content-Lengthなし/過少申告はarrayBufferで全受信後に検査され、拒否対象を上限なくバッファする経路。
- 保持: 認証/account/患者権限、10MiB正常画像、MIME/magic/hash検査、R2 immutable/DBreserve、既存public signature。変更: 実受信bytesが10MiBを超えた時点でstreamを中止し413、inspect/DB/R2前に拒否。既存宣言超過413と同じerror shape。従来の実byte超過400は413へ意図的変更。
- installed Hono bodyLimitはContent-Lengthありだとその値のみ判定し、stream超過時cancelを行わないため、この根本原因には単独で適さない。incoming-image.tsのbounded readを参考に、患者画像専用readerへ同じ上限を適用。共有incoming経路の改変はしない。
- 検証: 合成1MiB chunks/12MiB供給で11chunk目にcancel、残tail未読、DB/R2無し、Content-Lengthなし/過少。正常限界/分割magic/空/readerror、既存route/関連tests/typecheck。実データ/外部通信なし。


- F13結果: VERIFIED/ローカル統合 `c9cb1ed`。実inspectorを用いたroute REDは2 FAIL/既存64 PASS（全受信後400）。修正後は宣言なし/過少申告の12MiB streamが11chunk目でcancel/413、tail未読、inspect/DB/R2未実行。10MiBちょうどはbyte比較とdigestを保全、空bodyとstreamerror/lock解放も確認。処方せん12files182tests/Worker tsc PASS。
- 初回green実行では10MiB Uint8ArrayのVitest deep equalityが5秒制限を超えた。バイト数+Buffer.compareによる全byte一致へ変更し、条件を弱めず再実行してPASS。`F13-initial-green-attempt.log`に失敗を保持。timeout延長/skip無し。
- 新reader/上限定数は内部moduleへのadditive export、既存inspectのsignature/挙動は不変。routeは上限超過を早期413にする意図的変更、患者認可/正常API/R2保存/DB予約を維持。MIME正常時の実bytesをhash。readerrorは従来同様上位へ伝播、cancel失敗だけは413を維持してlock解放。
- `F13-red.log`, `F13-green.log`, `F13-snapshot.json`。4filesのみcommit、既存tests削除無し（mockは新readerを実装のまま使いinspectのみ差替えるpartial mockへ変更）。実Cloudflare/実患者画像は未使用。測定は合成streamのread/cancel/書込回数とbyte一致であり、Worker全体のpeak RSS/DoS耐性を保証しない。

## 統合checkpoint c9cb1ed

- `pnpm verify:ci` exit0。Worker2875/DB477/Web267/LIFF202/MCP36/installer80/update-engine228/SDK56/LINE8 tests、scripts246、25migrations、共有build/全workspace型検査PASS。入力`integration-F13-input.json`とF13 commit対象hash一致を確認。log `integration-F13-verify.log`。
- 更新後Workerを同じ合成wrangler/Vite構成でbuildしcompiled chunks/clientのみisolated runtimeへコピー、Miniflare localD1/R2でbootstrap投入→未認証401/薬局汎用write403/DB作成無し/未割当account一覧200空/outbound0、exit0。`F13-worker-artifact.json`（全収録hash/サイズ）、`F13-worker-build.log`、再現runner。build/runtime tempは終了時削除済み。画像LIFF認証込み実artifact uploadと全APIは未実施で、182 source回帰と区別。
- 削除/復旧consumerの限定確認は`recovery-consumer-investigation.md`。ETag条件付きtombstone+immutable writerで同key再PUTを防ぐ。backup復元全体の現在の削除記録維持、外部restore tool/全writer/readconsumerは未確認。正式RETENTION_MATRIXのhuman/policy blockersは解除していない。
- 現在HEAD c9cb1ed、コードtree clean、PLANS/evidenceのみ今回未commit。全体coverage/最終独立review/再探索は未完。子1threadは調査完了、close API無し。push/PR/deploy/実データ/外部送信なし。


## 復旧入口の追加照合（c9cb1ed）

- 前ターンはF13修復/統合検証のprogress。本ターンはrestore consumerの前提を照合し、restore_rehearsalのexecuteが409で明示拒否されることを確認。plaintext_restore/credential restoreは旧列互換の復元であり、全DB/R2snapshot復元ではない。backupMatchesもverified generationのvalidatorに限る。
- `recovery-consumer-investigation.md`補足03に根拠/読取り範囲/残件を記録。全backup復元と削除overlay保持は外部手順・証拠未確認。正式policy gateを変更しない。
- 製品コード変更なし、同一c9cb1edの既存verify:ci/Worker artifact PASSを再利用。検証反復/外部操作なし。次のローカル確認はintake field-level restoreのCAS/認可。独立レビューを含む全体Goalは未完。


## 問診の旧列復元の限定確認（c9cb1ed）

- intake-restore-investigation.mdに入力scope/approval/coverage/復号/2field CAS/batch guards/通常write freezeの静的確認と既存10+4testsの同一snapshot PASSを対応付けた。新規コード変更・検証反復なし。
- 旧列復元の失敗時rollbackとscopeを確認。outer execution期限確認→内部batchの間のrace、各pageで全coverageを再走査する資源コストは未実証の懸念として区別。これらを検証省略で解消しない。
- 全体Goal/独立レビュー未完。HEAD c9cb1ed不変、PLANS/evidenceのみ今回の未commit記録。


## 問診復元の資源測定（c9cb1ed）

- `intake-restore-investigation.md` MEASURE-02、合成10/50/100/200件×3回で全restore成功。200件4pageではenvelope読取り1,000回、中央値102.30ms（ローカルSQLite）。繰返し全件検証のコストを確認。本番遅延や制限超過は未確認。
- 製品変更なし。測定test/log/JSONを保存、一時source testは除去。既存統合結果再利用。全体Goalと必須独立レビューは未完。


## F14 consumer書込みのlease失効（再現済み・修正未完）

- 実SQLite/暗号化/helperで、実行fenceをbatch直前に失効させても平文消去がcommitし、後続progressだけ拒否されることを再現。`F14-brief.md`に契約根拠/再現/修正範囲/受入条件を保存。
- HEAD c9cb1ed不変。新規REDは既存欠陥の検出であり成功検証ではない。次は全intake migration writeに同transactionのexecution guardを実装。既存PLANS/evidence保全、外部操作なし。全体Goal未完。

- F14実装中: migrationの全writeを同batch execution guardへ接続。35近傍testsと型成功後、旧例外伝播保全/import整理を実施。最終再検証・他writeの注入・統合/artifact残。3source/test filesの未commit変更は今回のもの。


## F14 INTEGRATED — df98ebe

- 問診migration全writeの実行leaseを同batch前後で検査し、失効/差替え/別scopeを拒否。4source/test filesをローカルcommit df98ebebb6b134372d262fd32ba05ec66330998e。旧呼出/暗号・schema/API契約保持。
- 最終近傍61tests、verify:ci全体、Worker build/隔離artifact起動、実guardSQLのローカルD1 rollback検証がPASS。F14-brief/input/patch/counterreviewと各log/JSONを参照。既存audit_db限定レビューでは新規欠陥なし、fresh-context最終レビューとは区別。
- 本番D1/問診HTTP→D1の成果物E2E、全domain監査、全体独立レビューは未完。C01–C12/X01–X08のPARTIALを狭いPASSで格上げしない。PLANS/evidence未commitは今回の継続記録。


## F15 INTEGRATED — 385bd61

- webhookが全body読取り後にサイズ検査する欠陥をRED2caseで確認し、有界readerを画像処理と共有。既存10MiB画像exportと1MiBwebhook/署名textを保持。F15-brief/input/patchと各検証log参照。
- 近傍102tests/typecheck/verify:ci、compiled Workerのwebhook入口413/200+既存起動guardがPASS。source4pathsをローカルcommit。
- webhook1–532行の署名入口/inbox store/lease/sweep/ACKを読取り。後続handleEvent全consumer、raw payload生涯、cross-account side effectの全体監査は未完。C05/C09/X04の限定進捗であり全領域PARTIALを維持。


## webhook後続consumerの限定追跡（385bd61）

- webhook-consumer-investigation.mdにpharmacy早期return、同tenant cross-account送信、固定id/送信ledger、服薬回答のowner/CAS/SQL authorityを記録。既存同sourceの統合PASSを再利用し新たな全量検証なし。
- incoming-image/紹介route/event-bus全体、push期限遅延とnull envelope候補は残る。製品変更なし、全体監査/独立レビュー未完。


## 受信画像再送と削除marker（385bd61）

- incoming-image-investigation.mdに固定R2key/条件付き保存/retention/認証画像読取りを記録。実source+ローカルR2で同byte再送、誤ETag拒否、tombstone後再保存拒否、account別keyをexit0で確認。
- 製品変更なし。backup/lifecycle全体・本番は未確認。全domain監査/最終独立レビューは未完。


## 紹介リンク保存とconsumerの所属照合（385bd61）

- referral-scope-investigation.mdに保存DB triggersと実行側を分けて記録。保存時の関連resource所属は保護される一方、friends.ref_code→webhook intro送信のtenant照合は未確認候補。
- 次は合成fixtureで候補を反証/再現。薬局modeのgeneric送信抑止を確認しており本番越境は主張しない。製品変更・全量test再実行なし、全体Goal未完。


## F16 INTEGRATED — 5daae75

- generic webhookの別tenant referral intro送信を再現し、route/template両方のtenant一致を実装。F16-brief/input/patch、referral-reproduction-red/SQL-state参照。
- 62近傍tests/typecheck/verify:ci、Worker build/隔離artifact入口PASS。DB/FK/triggerを弱化せずref保存可能性も確認。正常送信契約保持。
- 薬局本番の発生を主張しない。LIFFその他ref consumer/全体監査/fresh-context最終レビューは未完。

### LIFF referral downstream checkpoint（F16後）
P=W=5daae756。referral-scope-investigation.md末尾に入口・tag/scenario DB制約・送信前enrollment順序を追記。薬局のlegacy OAuth拒否はliffRoutes自身で確認。既存26testsのF16統合PASSを再利用、今回製品変更/新test実行なし。tracked/affiliate notificationとlegacy null所有は未確認、coverageはPARTIALのまま。

### Affiliate notification checkpoint
5daae756固定、affiliate-notification-investigation.md追加。宛先account/tokenとledgerを追跡。generic conversionから薬局affiliate宛通知が到達し得るか未再現候補を具体化。次は承認authority/DB fixtureの反証。製品変更なし、既存26tests結果再利用。

### Affiliate notification candidate disposition
同HEADで入口連鎖を追い、薬局schemaが存在する場合の汎用成果承認API拒否を確認。affiliate-notification-investigation.mdの候補は現行HTTP経路で反証され、修復採択しない。既存guard/access41tests PASS再利用、新規実行なし。次はtracked-link consumer。

### F17 integrated
87e6987cad9d01148286062a827b7901e0acd60c: tracked-link PATCHが所有確認前に更新する欠陥を修復。RED3FAIL→near58PASS、type/verify/build/artifact0、patch再適用一致。F17-brief.md/result.json参照。次はapp redirect HTMLのURL保持/escape候補。全Goal未完。

### F18 integrated
412c6c958c96b29c179ec64f14b3337d3cdb499f: app redirectのHTML/script context混同を修復。RED3FAIL→19PASS、Chromium3case、verify/build/runtime0、P→W patch再適用一致。F18-brief.md参照。全Goalは未完、次は追跡リンク保存・公開consumerの残項目をcoverageへ整理し、別の未被覆領域へ進む。

### Public preview consumer checkpoint
412c6c9固定。public-preview-review.md/source.jsonに確認範囲・module状態を記録。OG builder/resolverの現行用途確認、index preview/SPAfallback部分確認。既存27tests結果再利用、新規実行なし。次はcronの未被覆consumer。

### F19 integrated — pharmacy Meet cron
fb6ab3452d047befd539c6c965187ab0f7425b70: 薬局Meet reminder processorがgeneric cron gateで実行されない欠陥修復。実scheduled入口RED2FAIL→near33PASS、verify/build/runtime0。compiled scheduled + synthetic D1でprocessor到達とcredential無し拒否確認。F19-brief.md/result.json参照。cron全体はindex1032–endを読取ったが各consumer未確認のためPARTIAL、次はtoken-refresh更新競合/credential consumerを必要範囲で確認。

### Token refresh checkpoint
fb6ab34固定。token-refresh-investigation.mdにCAS/暗号/ログ経路と未確認の無期限通信待ちを記録。既存14tests PASS再利用、製品変更なし。次は有限の障害注入によるrefresh待ちと後続cronの依存確認。

### Token refresh bounded measurement
fb6ab34固定、合成fetch100ms保留→直列待機/abort signal無し、解放後全完了を測定。token-refresh-delay-result.json/log/case.txt保存、一時test削除、製品変更なし。SLO違反とは未断定、同測定反復は終了し医療通知consumerへ。

### Medication notification checkpoint
fb6ab34固定。medication-notification-investigation.mdに選択→transition→credential→approved sender→最終権限→deliveredの確認と、停止中先頭50件による後続飢餓候補を記録。次は有限51件の実query再現。新規製品変更/検証実行なし。

### F20 adopted
先頭50件停止による後続通知の選択停止を全bootstrapSQLite/実processor2tickで再現。F20-brief.mdに修復案と互換/上限の受入条件を記録、状態PLANNED。製品未変更、一時再現testはcaseへ保存し削除。

### F20 implementation checkpoint
RUNNING、未commit。追加migration/marker/公平な選択順と回帰3case実装。近傍10PASS、Worker型PASS。migration互換・競合・負荷・統合・artifact未完。F20-brief.md末尾の残項目から再開。

### F20 compatibility checkpoint
RUNNING未commit。旧schema→027の既存row全値保全と旧UPDATE互換1PASS、marker scope/単調時刻/旧rowshape含むnear10PASS。F20-brief.md末尾に未実施を列挙。

### F20 integrated
d595215010ac956d5f697b7cc8083c26f3966787。paused/failed/missing credential先頭群で後続が進まない欠陥修復。内部queue timestamp/additive027、旧schema fallback、scope/版/時刻保全。新7testsと統合verify/build/runtime/patch再適用成功。F20-brief.md/result.jsonに詳細と失敗履歴、負荷、制約。全Goal/最終独立レビュー未完、次は同様の限定queueを使う他の医療通知consumerを確認。

## 継続案内の追加調査

`continuity-queue-investigation.md`: 2回の6時間cron相当で同じ50件が選ばれ、別テナントの51件目に届かない欠陥を合成SQLiteで再現（1PASS、外部通信0）。F21修復・互換検証は未完。初回fixture制約違反もログに保存。

## F21 — 継続案内の通知待ち停滞を修復

Local commit `24c336a50466d0afd8190576efb5a4ca529a880e`。`F21-brief.md`/input/result/patchに完全記録。nullable metadata追加・旧schema fallback・clinical状態保全。near38PASS、全verify:ci/build/compiled6h cron PASS、50→51確認（外部0）。旧schema/旧UPDATE/migration互換・tenant/account/CAS/復帰/監査/単調時刻を確認。追加50writes/cron、N50/500/5000中央値の増分約0.98/1.37/1.23ms。限定read-onlyレビューhash照合済み、fresh最終独立レビューは未完。全体coverageはPARTIALのまま。

## 次の修復対象 — 終了後の継続案内送信

`continuity-stale-send-investigation.md`。CONFIRMED_BUG P2: actual account/CAS staff end後、古い取得行からactual shared senderが送信境界へ進む。合成SQLite1PASS（欠陥再現）、送信スタブ1回、外部0、最終ended/version2。F22修復未着手。全体Goal未完。

## F22 — 終了後の継続案内送信を修復

Local commit `538de9f680ce5360aa00b59e5953382fafa56aa6`、完全記録`F22-brief.md`/input/result/patch。最終送信scopeでexpectation/parent/account/friend/patient/current statusを再検証。終了・欠落・不整合は送信なし、pausedは再試行保持。過去unknownをblockedへ上書きする候補Wの欠陥もRED再現して修正し、unknown保持・24h照合経路を確認。near79PASS、最終全verify:ci/build/compiled cronD1 PASS（外部0）、限定review hash照合済み。schema/API/payload/retrykey変更なし。既存一般patient/account guardのunknown意味論は隣接未確認として残す。全体coverage/fresh最終レビュー未完。

## F23 — 共通送信停止時の結果不明を保全

Local commit `75cf0b78894dc92fa61620401bbd1b796b33c206`。完全記録F23-brief/input/result/patch。initial/postclaim/final patient/final account停止でunknownがblockedに変わる4経路を実SQLite REDで確認して修復。初回/knownfailedのblockedを維持、6新規回帰・既存mock SQL4箇所のみ意図的更新。near85PASS、最終全verify:ci/build/compiled cronD1 PASS（外部0）。限定レビューhash照合済み。API/schema/payload/retrykey不変、全体coverage/fresh最終レビュー未完。

## 有効期限通知の追加調査

`validity-queue-investigation.md`: CONFIRMED_BUG P2、6時間2回で停止中tenantの同じ先頭50行を繰返し、別tenantの51行目を選ばないことを実SQLiteで再現。1PASSは欠陥再現、外部0。F24修復未着手。全体Goal継続。

## F24 — 有効期限通知の待機処理停滞を修復

Local commit `fa43ab1e53a60e6154ad528a7ee2453e0774cbf4`、完全記録F24-brief/input/result/patch。029custom081 additive metadataを既存claimで記録、release後も処理順前進。near16PASS、全verify:ci/build/compiled6h cronD1 50→51PASS（外部0）、旧schema/旧UPDATE/移行/期限日保全を確認。性能増分N50/500/5000中央値0.101/0.355/0.782ms、追加rowUPDATEなし。新indexは今回planでは不使用・remoteD1未測定。限定review hash照合、全体coverage/fresh最終reviewは未完。次はclaim後のvalidity/処方せん状態変更と送信確定stampの整合を調査。

## 有効期限通知の訂正競合

`validity-stale-date-investigation.md`: CONFIRMED_BUG P2、actual staff saveで期限24→25訂正後、actual shared senderが旧24日payloadを送信境界へ渡すことを実SQLiteで再現。1PASSは欠陥再現、provider stub1/外部0。F25修復未着手。sent集計値は意味が未確定で別bugと断定しない。

### F25 — 期限通知の最新状態再照合 (FIX / P2 / CONFIRMED_BUG)

INTEGRATED `10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e`、P=`fa43ab1e53a60e6154ad528a7ee2453e0774cbf4`、primary/dev。sharedsender+新実SQLite回帰の2paths。実スタッフ訂正後に旧期限を送る不具合を再現し、送信直前SQLでcurrent date/verified/ready/due/claim/sent/account/friend/patientを確認。既存caller retrykey/varsから解決し公開input/schema/期間規則は維持。再確認25時間後も未送信が確実な通知を再試行でき、過去unknownはattempted保持。
旧P RED7FAIL、初期candidate再確認16分RED1FAIL、更新candidate25h RED1FAIL、最終近傍64PASS/fullverify0/compiledWorker+localD1 final期限訂正0egress PASS。F25-input/patch/result/briefに全hash/command/失敗と限界、patch isolated2path再現。限定reviewを読み全hash照合、fresh全体reviewは未完。最終read→provider競合/claim所有証明は解消していない。Node26、CI Node22未実施。PLANS/evidenceは未stageで保持、外部操作なし。

### F26候補 — 共通送信の長期一時停止からの再開

CONFIRMED_BUG/P2、未修復。F25統合後P=10d1198、continuity実pause→初回provider0/skipped→active再開25h後がskippedのまま。paused-resume-investigation.md/case.txt/red.log、1FAIL18filtered。未送信attemptedの24h制限が原因、真のunknown保護は維持が必要。共通一時gateの到達を確認後、凝集した修復packetとして続行。

### F26 — 一時保留の再開と通知結果の更新権 (FIX / P2)

INTEGRATED `362737be415b11577535486a6d68f7d67edd728b`、P=`10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e`。primary/dev、sender+unit+actualSQLite3paths。provider未呼出の一時gateは既存unknownでなければfailedとして再試行可能にし、25h再開を保全。reviewerの古いcallerによるunknown上書き懸念R1をactualSQLite REDで確認し、markOutcome全6callerでclaim時occurred_atとattemptedのCASを追加。
旧P RED7FAIL48PASS、race候補RED1FAIL、最終近傍75PASS/fullverify0/build0/compiledlocalD1 runtime0。F26-input/patch/result/briefに全記録、isolatedpatch3paths再現。限定review2記録を親読取/全hash照合、fresh最終review未実施。新schema/API/dependencyなし、provider開始自体の排他や任意時計巻戻しまで保証しない。Node26、CI Node22未実施。PLANS/evidence未stageで保持、外部操作なし。

F-DIST-01追補: F26後HEADでactual tar.gz parser+verifierのmigration-only差替えを実行再現、期待拒否test1FAIL。distribution-migration-tamper-case.txt/red.log参照。未修復、旧artifact信頼根拠/後方互換設計は継続課題。

### F27候補 — 利用者をまたぐ未送信下書き

CONFIRMED_BUG/P1、C-UI-03をactualChromium+LIFF subject mockで再現。A入力が同LIFFのB画面へ復元、browser期待空欄1FAIL。draft-subject-investigation.md/case/log/pngに条件と未実施。未修復、既存下書きの非破壊保全と主体別キー/sweepを次に具体化する。

### F27 — LINE利用者ごとの下書き分離 (FIX / P1)

INTEGRATED `3be2dbf1bed931fbf98cca4e40f934fce2058ba4`、P=`362737be415b11577535486a6d68f7d67edd728b`、primary/dev。新旧患者下書きとsweepをLIFF+LINE userで分離。未帰属legacyのfirst-claimを止め、旧bytesは削除/上書きせず保全。新keyは旧sweep対象外。公開server契約/送信/認可は不変、旧local helperとenvelopeを維持。
修正前browser4FAIL（新規プロフィール漏出、legacy自動採用、別利用者draft削除、同患者を共有する利用者への未送信回答漏出）→修正後新4+既存7=11PASS、LIFF28files205PASS、fullverify0、productionLIFF build0/distコピーstartup1PASS。F27-input/patch/result/brief/artifactに識別情報と全記録。限定reviewを親が全文読取/5hash照合、isolated P→W再現、明示5pathsだけstageしてlocalcommit。
重要な限界: 旧未帰属draftの自動復元/安全な移行を提供せず保存を維持するため、現版での旧key24h削除も保証しない。旧clientへのrollbackは元privacy欠陥を再導入し得る。実LINE/WebView/同mountedSPA中の外部主体切替は未検証。fresh最終review/全体監査は未完。外部操作なし、PLANS/evidence未stage保持。

### F28 — plugin MCP設定例 (FIX / P3)
INTEGRATED `797a7cbc56e857a63b104a68cb2bf343bdb8f93d`、P=`3be2dbf1bed931fbf98cca4e40f934fce2058ba4`。README表/JSON例とMCP indexコメントの2pathsのみ。getClients必須tenant ID欠落を修復、両JSON例をparseしrequired4keys比較: missing1→0。patch isolated2paths再現/hash/限定review親確認、diffcheck0。runtime無変更のため全verify/build反復なし。fresh全体review未実施。F28-input/brief/result/example-check参照。

module-assignments.jsonはcurrent tracked自作TS/JS/SQL1261pathsを125moduleへ割当（tests/生成物も明示、baseline LOC母集団とは別）。列挙だけでREVIEWEDにしない。shared-review.mdはpure sticker/indexを範囲限定REVIEWED、型と全APIとの一致はPARTIAL。plugin-template-review.mdはPT-01修復、PT-02ログ境界を次packetへ。

### F29 — plugin雛形の本文漏出防止 (FIX / P2)

INTEGRATED `34b32dfd1d0d2447b7bb324a8e4ef4f5704169b0`、P=`797a7cbc56e857a63b104a68cb2bf343bdb8f93d`、primary/dev、5paths。Webhook body/parse exceptionとMyService HTTP/network/parse raw errorを固定ログ・statusへ限定。RED6FAIL1PASS→最終8PASS。初期full integration0、最終MCP変更はtypecheck/build/8tests/compiledWorker+MCP0で検証更新。旧tracked bundleが古いため正規build再生成を含む（737017→1338902B）、same-deps P再生成との増分547B/84diff行。再生成でJSONSchema additionalProperties:false省略を検出し、正本のregisterTool+Zod metadataで旧契約を保持。旧/current compiled tools/list exact一致、6inputvalidation一致PASS。
F29-input/patch/result/brief/provenance-final/artifact/contract-finalに証拠。5paths isolatedpatch再現、限定review3記録を親全文読取/hash確認。生成依存template literal空白1件によりdiffcheck exit2、直接trimせず記録。CI Node22/実provider/全依存動作/署名TODO/別PT課題/fresh全体review未完。外部操作なし、PLANS/evidenceは未stage保持。

### F30 — template通知の準備gate (FIX / P2)

INTEGRATED `6751d6edcb164dd8e4ac59fc53824a438bfac13d`、P=`34b32dfd1d0d2447b7bb324a8e4ef4f5704169b0`、primary/dev、notify/README/newtest3paths。新規scenarioはinactive→step→activate、既存はactive/stepCount>0/trigger一致を確認後にdedup tag付与。途中状態や人の停止を勝手に再有効化せず、管理画面で完成・有効化後に再開可能。従来step/タグ/公開API保持。
RED9FAIL→最終notify9+既存privacy8PASS、scripts25files263PASS、plugin typecheck/build0、copiedWorker+SDKdistのscheduled success2run/dedup・stepfailure/retry0。F30-artifact/input/patch/brief/resultに識別情報と証拠。3pathisolatedpatch/hash/限定review追補を親確認、diffcheck0、明示3pathsだけlocalcommit。会員通知は共通helper静的確認、失敗専用runtimeは予約側。並行外部変更/同名create競合/過去に消費済のタグ/CI Node22/fresh最終reviewは未解決。外部操作なし。

auth-login-review.md/input.json: primaryがlogin/change-password・credentials/throttle・sessionguardを範囲限定追加確認。既存認証ソース/テスト不変を確認しF29統合PASSを再利用。Map mockと実SQLiteテストを区別、last_seen競合/全tenant-boundaryなど残す。新たな確定欠陥なし、全auth REVIEWEDではない。module割当へF29/F30の新tests2pathsを追記（基準LOC母集団不変）。

### F31 — scenario stepの親/tenant拘束 (FIX / P1)

INTEGRATED `da40c463db40423af8bbc32ce2ade603949bcffb`、P=`6751d6edcb164dd8e4ac59fc53824a438bfac13d`、primary/dev、DBhelper/route/newactualSQLite test3paths。認可済parent URLにforeign stepIdを混ぜるupdate/delete/read漏れをSQLの親+servertenant predicateで修復。旧publichelper引数は保持しoptional scopeを追加、現repo2route callerは必ずscope。NULLtenant/emptyupdate/DELETE200等の互換維持。
RED4FAIL2PASS→new10+既存22=32PASS、fullverify0、Vitebuild/compiledfullWorker0、合成identity compiledguard/route/nativeD1でforeignPUT404/delete無変更・own操作0。fullapp薬局generic403は維持し、実薬局到達/被害とは別。F31-input/patch/result/artifact/native-scopeに証拠、限定review親全文/hash確認、isolated3path再現、diffcheck0。Node22/全auth/全nestedroute/fresh最終review未完、外部操作なし。

F-DIST-01: ユーザー回答「わからない」により旧migration信頼hash参照先は不明。待ち状態ではなく未解決として記録、推測hashや無条件旧版拒否を導入しない。

tenant-boundary-review.md/input.json: guard214行/tests328行/登録順とaccess1–249を追加確認。親認可では子IDを保護できない経路をF31で修復。richmenu nested mutationsは子による限定調査中。全tenant-boundary/全routeはPARTIAL。

tenant-rich-menu-review.md: 既存childの限定read-only記録を親が全文読取/5hash確認。image所属検証、foreign page IDの新UUID化、group単位削除によりF31同型の通常nested ID混同を対象範囲で反証。画像check→update競合は通常APIでのpage移管経路が未確認のconcern、未修復。publish/import等全体は未読、全richmenu完了とはしない。子は完了済みだがclose APIなしのためthreadは保持、新規childなし。

### F32 — 手動チャットの例外本文ログ防止 (FIX / P1)

INTEGRATED `044e817d2685edad303bc1fe0708200855c0e3a8`、P=`da40c463db40423af8bbc32ce2ade603949bcffb`、primary/dev、route+既存testの2paths。JSON parse/request/flex/imageと依存throwの生例外ログを固定eventへ変更、HTTP500/認可/送信/保存順序は維持。短い合成markerで旧P4FAIL10PASS→近傍18PASS、Worker型0/fullverify0（Worker269files2996PASS）。F32-result/input/W/patch/execution-statusに証拠、isolatedpatch2paths再現、限定review親全文/hash確認、diffcheck0。Node22/nativeWorkerd/実provider/fresh最終reviewは未実施。他CRMログ/全認可は未完、chat-conversation-review.mdに次の確認範囲。PLANS/evidence未stage保全、外部操作なし。

### F33候補 — 混在日時によるチャット誤表示・要対応残留

CONFIRMED_BUG/P2、未修復、P=044e817d。現行webhook JSTとtracked send UTCを文字列比較するreader不整合。実Hono+SQLite final1FAILでdetail逆順/limit1→before欠落、一覧preview古いincoming、返信済queue/inbox各1（期待0）を確認。chat-time-investigation.md/input.json/final-red.log参照。child consumer調査を親全文/6hash確認。修復は3readerの日時比較・argmax・cursorを凝集packetへ、性能比較未実施。
operator-scope-review.md: 薬局operators通常到達はallowlist/disabled guardで反証、汎用global operatorのmulti-tenant契約は未確定concern。今回製品変更なし、F32検証結果再利用。

### F33 — チャット日時の瞬間比較 (FIX / P2)

INTEGRATED `f3d3dc401a8859dd137bb9163752e9bb3425c124`、P=`044e817d2685edad303bc1fe0708200855c0e3a8`、primary/dev、3reader+actualSQLite test4paths。JST/UTC既存保存値を維持して履歴・一覧argmax・未対応判定を瞬間比較、一覧cursorも既存latest-message-or-chat-fallback意味へ整合。旧P最終10case6FAIL4PASS→最終Worker270files3006PASS/typecheck0、初期fullverify0（最終変更はWorker全体へ再検証）、compiledlocalD1 runtime0/egress0。性能50/500/5000件の旧新9回中央値0.611→0.669/1.671→1.692/12.334→12.704ms、事前閾値内。
F33-result/input/W/patch/performance/nativeに全証拠、isolated4path再現、限定review追補親全文/hash確認、diffcheck0。初期metadata優先案は公開field意味保持のため訂正し検証更新。全NULLcursor/同instant timestamp-only cursor/非ISO/Node22/fresh最終review/全体監査は未完。PLANS/evidence未stage保全、外部操作なし。

### F34 — CRM例外の機密出力防止 (FIX / P1、F32同根の追加経路)

INTEGRATED `abda3847979e19b906ebe3f81c61cfac03cf901c`、P=`f3d3dc401a8859dd137bb9163752e9bb3425c124`、primary/dev、chats/conversations/newtest3paths。残10catchを固定log、conversationsの500内部error詳細を固定文面へ。旧P14FAIL→近傍82PASS、Worker271files3020PASS/typecheck0。badJSON4caseは実SQLite/route、DBfault10caseは合成prepare throwでsinkを確認。成功/認可/保存順序維持。
F34-result/input/W/patch/execution-statusに全記録。isolated3path再現、限定review親全文/hash照合、diffcheck0。不変workspaceはF33全体verify再利用。nativeWorkerd/Node22/実provider/fresh最終review未実施、全repo log安全性の主張なし。PLANS/evidence保全、外部操作なし。

### F35 — 保存中チャットメモの入力保護 (FIX / P2)

INTEGRATED `55c170b1c4ec61c54ef1a93bffb892f36d08c529`、P=`abda3847979e19b906ebe3f81c61cfac03cf901c`、primary/dev、page+browser test2paths。dirty/revisionでsave/status refreshから未保存入力を保護、A→B→Aを含む旧saveから現在draftを隔離。旧P最終5FAIL1PASS→W6PASS、web55files267PASS、型0。F35-result/input/W/patch/execution-statusに証拠。isolatedpatch2path再現、限定review親全文/hash確認、diffcheck0。Node22/本番API/複数tab/fresh全体review未実施。既存PLANS/evidence保全、外部操作なし。

### F36 — DSR保存判定の世代とCAS保全 (FIX / P2)

INTEGRATED `6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b`、P=`55c170b1c4ec61c54ef1a93bffb892f36d08c529`、primary/dev、repository+実SQLite回帰2paths。新規受付は現MAX+1、遷移はbatch固有eventが両hold更新の条件。旧P5FAIL15PASSと中間CAS1FAIL19PASS→最終20PASS、全verify0（DB486/Worker3020等）、compilednativeD1 access workflow/epoch0/egress0。F36-result/input/W/patch/execution-status/nativeに証拠。初期fixture/runner誤りを訂正して記録、限定reviewで競合追加修復、親全文/hash照合、isolatedpatch0、diffcheck0。全体監査/freshreview/Node22未完。

F37候補: native D1で既存latestPhiRecordedAtがtoo many terms in compound SELECTとなりunknown固定。retention-union-investigation.md。data-subject-hold-review.mdのmalformed日時は別concern。

### F37 — 保存期間集計のnative D1互換 (FIX / P2)

INTEGRATED `3158e7c337a3d43022b1db6fd0a4ce0fc4877257`、P=`6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b`、primary/dev、legal-hold+native回帰2paths。flat33source UNIONのnativeエラーを5term階層化で修復、全source/66bind/単一SQL/unknown保全。旧Pnative1FAIL→新native1+既存20PASS、全verify0（DB487/Worker3020等）、compiled DSR erasure workflow0/egress0。性能50/500/5000中央値0.189→0.201/0.290→0.316/1.408→1.339msで事前閾値内。F37-result/input/W/patch/execution-status/native/performanceに証拠、限定review親全文/hash確認、isolatedpatch0/diffcheck0。初期2群案はnative失敗し採用せず。Node22/全retention/fresh全体review/既存malformed日時候補は未完。

### F38 — 保存判定の正確な日時検証 (FIX / P2)

INTEGRATED `f6a88eedd15094ea52162ac168856647de0aedc8`、P=`3158e7c337a3d43022b1db6fd0a4ce0fc4877257`、primary/dev、legal-hold/fence/tests5paths。JS ISO roundtripとSQL strftime正規化一致で不正暦日をunknown、native GLOB過長例外を解消。有効閏日/期間/全source/SQLscope/公開contract保持。旧P Worker7FAIL59PASS/native2FAIL→W近傍66+22PASS、全verify0（Worker3030/DB488等）、compilednative0/egress0。性能5k中央値1.447→3.681ms、同じ事前閾値内だがコスト増あり。F38-result/input/W/patch/execution-status/native/performanceに証拠、限定review親全文/hash一致、isolated5path0/diffcheck0。Node22/本番/fresh全体review未実施。

F39候補: candidate selection/preflightの77byte GLOBもnativeでtoo complex。retention-selection-glob-investigation.md/json。DSR判定修復と全retention完了を区別、次の有限packetへ。


## F42後の監査再照合・次の有限作業

- F39–F42: 各 `FNN-result.md` / commit / W / patch / verification / limited-review記録を正本とする。全体coverage tableのPARTIALは維持。最新統合verify:ciはF42、再実行不要（現source不変）。
- 割当台帳はF38時点のpath一覧だが、現在1,268件との差分集合は空。内容変更4pathをcoverage-reconciliation-F42.jsonで識別した。一覧化をreview完了と扱わない。
- MCP画像経路を追加調査: tool→SDK /api/images→auth/allowlist/account authorization→R2/public/private配信を限定追跡。薬局画像DELETEはindex.ts259のallowlistで403、route単体を認可欠陥と扱わない。既存generic-feature-guardの対応testはF42fullverifyで成功済み。
- 次F43: `image-upload-investigation.md`。不正JSON入力が画像POST例外ログへ転載されることをcompiled actual route/合成短いcanaryで確認。レスポンスは固定500、R2未操作。全認証E2E・本番漏洩は未確認。
- 残る有限領域: webhook後段consumer/署名・生涯、MCP未読tool/Worker契約、Web/LIFF未読flow、migration/配布/供給網とNode22、採択hotspot・restore資源懸念。旧OSS hash台帳不明とfresh最終独立review不足を黙って除外しない。

### F44 — 未捕捉ルート例外の共通境界 (FIX / P2)

INTEGRATED `49ee0d2162e10761403b7d4fc8f1e0380a171d26`、P=`6c940754b3661df5eeeda1dedf46612dfa256137`、primary/dev、index+新handler+test 3paths。Hono既定handlerの例外本文ログをapp.onErrorで固定イベントへ置換、getResponse転送（HTTPException/duck-typed）と既定500 text/middleware headerを保持。RED1FAIL→新3PASS、Worker272files3064PASS/typecheck0/build0、GET画像実bundle probeでsentinel非出力。F44-result/commit/image-probeに記録。cron/Node22/nativeWorkerd/本番/fresh最終reviewは未実施。PLANS/evidence未stage保持、外部操作なし。
