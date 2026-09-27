# F30 限定 read-only review

ID: F30-LR。担当: audit_db（既存thread再利用）。基準 P: `34b32dfd1d0d2447b7bb324a8e4ef4f5704169b0`。W は F30-input.json 固定3paths。全体 fresh-context 最終独立レビューではない。

結論: 指定されたセットアップ失敗・既存停止/空/trigger不一致による誤タグ消費について、新たな阻害 finding は確認しなかった。判定確度は静的コード照合として高い。送信成功・任意並行変更まで保証する結論ではない。

## P / W SHA256

| path | P SHA256 | W SHA256 |
|---|---|---|
| `packages/plugin-template/src/notify.ts` | `a8bfa918be90cffbbece00bbef19fc1bb9dae808b527fef5e8aa39f717b73f41` | `3cfd781474d70b425804ca974683832cf969cc561ea1a8b6875731cc53962ef8` |
| `packages/plugin-template/README.md` | `aa48a3029e83bebf286530b5170a669e4c829d0dd172de8c03318816be0ab9d6` | `6e82ac20fc1f629f7ada185555d4dfc2187483b8d6b136c6dabc87c1119100ac` |
| `scripts/plugin-template-notify.test.ts` | `不存在（新規）` | `07c61f52749050710be6fb41c99179465c00be6d6dda496cd83e1e4f87b0e4c2` |

読取り終了時に HEAD と P 一致、3つの W および既存2つの P SHA256 一致を独自確認。

## 保持契約と確認

- `notify.ts` 全文: 新規は `create(isActive:false)` → `addStep` → `update(isActive:true)` を await。いずれか失敗すると友だちループ前に停止し、dedup用タグを付けない。作成/step成功の応答喪失では途中状態を残し、人による確認を要求する。activation が成立した後の応答喪失なら次回 list で ready を確認して再開可能。
- 既存は name 一致だけで採用せず、active、stepCount > 0、tag_added、triggerTagId一致を確認。拒否では既存step/active/triggerを変更せず、deleteもない。利用者による停止を勝手に解除しない。人による復旧後はstepを上書きせず、既存friendタグを保持してdedupする。
- 予約/会員の両経路で同一helperをタグ付与前にawaitする。setupは per-friend try/catch の外。`checkAndNotify` → `scheduled` まで例外伝播。予約setup失敗時は後続会員処理も実行されない（安全停止の運用上の影響）。friend個別のaddTag失敗catchは従来通り。
- SDK `scenarios.list/create/update/addStep` と `http.ts` を全文読取り。defaultAccountId、tenant header、HTTP non2xx rejection、fetch/json rejection伝播を維持。外部API/schema/export/static messageの変更なし。
- 実API `scenarios.ts` のserialize/list/create/update/step作成部分を照合。isActiveはBooleanへserialize、create falseを保持、update false/trueをDB値へ変換。`stepCount` はDB helperの LEFT JOIN + COUNT(ss.id) で0を含む件数。SDKモックだけが持つ架空fieldではない。
- DB `getScenariosForAccount/getScenariosForTenant` を読取り。account指定は当該accountと同tenantのglobal、未指定はtenant一覧という従来の範囲。F30はscopeを変更しない。認証middleware全体の再監査は実施していない。
- README復旧案内は上記と一致。旧versionへrollbackすれば元の誤消費リスクも復活するが、永続形式/APIに破壊的変更はない。

## テストと証拠の評価

新規テスト全文を読取り。実SDKと合成fetch状態を使用し、inactive→step→active→attach順、step失敗後の次cron、activation失敗/応答喪失、既存4種拒否、人の復旧とdedupを9caseで確認する構造。step保持と不要な更新がないこともassertする。全9caseが予約側を直接検証し、会員側の同様な失敗は専用caseなし（共通helperと両callerを静的確認）。fixtureは実D1/認証middleware/実LINE送信ではない。

親作成の `F30-red-once.log` 冒頭は9FAIL、`F30-green.log` はnotify9+privacy8の17PASS。レビュー担当はこれらを証拠として読んだだけで、テスト成功を独自実行したとは扱わない。inputのpatchReplay PASSも親証拠であり、こちらで再実行していない。

## 読取範囲・コマンド

- root既存指示、packages/AGENTS.md（再読）、既読Worker指示を適用。
- 全文: notify.ts、新規test、SDK resources/scenarios.ts/http.ts、plugin src/index.ts、F30-input.json/brief/green.log。
- 部分: README差分、Worker routes/messaging/scenarios.ts serialize/list/create/update/step作成、DB src/scenarios.ts list helpers、red-once冒頭。
- `git diff -- packages/plugin-template/README.md` とnotify差分、`sed`/`cat`/`rg` による上記読取り。最初の `rg ... packages/db/src/queries/scenarios.ts` は存在しないpathで失敗し、`rg`で正しい `packages/db/src/scenarios.ts` を解決した。隠蔽や検証成功への読み替えなし。
- Python hashlib + `git rev-parse HEAD` + `git show P:path` の読み取りでhash照合成功。記録以外のファイル書込なし。

## finding・未確認・統合注意

確定した新規欠陥: なし（限定範囲）。残存制約は、同名scenario create競合、list/activate後の他者pause/step削除/trigger変更、tag追加後の配信失敗、任意の既存step内容の安全性/条件成立/順序整合、タグの作成応答喪失。stepCount > 0 は配信完了保証ではない。これらを今回解決済みとして扱わない。

既存不適格scenarioは人の確認まで停止する設計。通知対象0件でもsetupを確認/作成する従来構造、optional LINE_ACCOUNT_ID の既存tenant一覧動作は不変。薬局本番の通知経路と同一視しない。

独自test/build/Worker compiled scheduled実行/外部接続/実データアクセスは未実施。親の進行中typecheck/build/scripts/compiled scheduled成果を本記録でPASS認定しない。統合時は固定3hashと親の最終検証結果を照合すること。ソース変更・commit・patch作成は非該当。作成物はこの記録のみ。過去記録は保持。


## 最終 fixture 更新の追補

基準Pは不変。旧レビューと失敗・未実施記録は上に保持する。最終Wのtest SHA256は `7c496fecc78297196fe6d99623e51d8729b6dc24d2da49663d032d953c49b354`、notify/READMEは上表から不変。全3W hashとHEAD=Pを再照合成功。testの `triggerType: 'friend_add'` を旧 `friend_added` に逆置換したbytesのhashが旧Wと一致するため、この1文字列以外に変更がないことも独自確認した。実enumは packages/shared/src/types.ts:119 と packages/db/src/scenarios.ts:3 の friend_add/tag_added/manual。不適合な実在triggerを拒否する回帰となり、期待契約・検証強度の弱化なし。限定結論は不変。

追加読取: F30-result.json/input.json/green-final.log/artifact.json/artifact.log/typecheck.log/worker-build.log、scripts.log末尾、artifact-smoke.mjs全文、実enum定義。親の最終notify9PASS、既存privacy8再利用、scripts25files263PASS、typecheck/build exit0を記録/ログで照合。typecheckログ自体はコマンド行のみでありexit0はresult記録による。3path isolated replay PASSはinput/result記録によるもので担当自身の再実行ではない。

artifact-smokeは生成Worker distとSDK package.json/distを一時領域へcopyし、source symlinkに頼らずcompiled scheduledをimportする。全fetchを合成handlerで置換し、successを2回実行してdedup、stepfailure→再実行でinactive/stepCount0/未attachをassertする構造。artifact JSON/logは双方exit0、success/step-failure PASSで一致。Worker artifact SHA256 `85211d7d28d09e87b07680a3eb5e0c067c1194e818dde095bcf9064bbb197ddd`、SDK `aa91101b2d508536266ec6b7e1b4ef0fcd65268fbd3faa984b47525c234c45d2` と記録される。これは親のcompiled実行証拠を静的照合したもので、本担当がartifactを実行したとの主張ではない。

担当の追加実行はcat/sed/tail/rg、Python読取りhash照合とこの追補のみ。source/Git変更・外部接続・tests/build実行なし。上記「親進行中」はこの追補で証拠照合済みに更新するが、独自未実行・並行変更保証外・fresh全体レビューでない等の限界は維持する。
