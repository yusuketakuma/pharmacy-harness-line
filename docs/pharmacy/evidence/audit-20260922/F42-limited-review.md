# F42 限定 read-only review

ID F42-LR / audit_db、P `f0d1fe0f0533ba4020cd5b7ccddb85f4d6228122`、HEAD/P/W2hash一致。再利用thread、fresh全体最終レビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts` | `d5720befff717a4f51ba6b87002aeb1112ccd2c72a40c411eba621927e91e625` | `40c89c600b7a66a8fbce94019b93c847713d57d9d51c34b6d04bcf90b76ff61c` |
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.test.ts` | `760772144ef6f3071791616cb1cb2ea8b37b4cb73bbc4e7a44b826e33b87da0e` | `eb9ec06c3d9ad2d6068b7bc5d75b477b77d379dfbf6473a0ff82f67880347143` |

## 判定と正確性

限定差分に阻害findingなし（静的確度高）。VALID_CREATED_ATで有効な固定幅UTC秒prefixとASCII数字fractionに制約された値について、prefix+'.'+fraction末尾0除去は同instantを同keyにする。全zero/秒なしは末尾dotで一致。異なるfractionは最初に異なる数字で大小が決まり、一方が他方のprefixなら短い方が小さい（非zero残余の分だけ長い方が大）。末尾Zを除くことで旧 .09Z/.099Z の逆転がない。日付/秒prefixは固定幅なので先に比較される。浮動小数点やms丸めなしで任意桁の正確さを保持。

cutoffは既存Date.toISOString出力末尾Zを除きfraction末尾zeroをtrimするため同じkey形式となる。dotでtrimが止まり秒欄のzeroを削らない。SQL値がNULLならkeyNULL、既存VALIDが0なので候補に入らない。SQLの評価順そのものは保証されなくてもkeyはsubstr/rtrimのみで例外を起こす処理を含まない。

due/eligible/markerの3cutoff比較、2ORDERすべて同keyへ統一。ORDERの第二キーintake.idは維持し、同instant異表記もID順になる。filterをLIMIT前に適用し、markerでcurrent valid/current keyを再確認するため候補後に等境界へ変更してもpurge markerを作らない。placeholder数/順は不変でcutoff値だけkeyへ。account/owner/hold/retention_days/NULL policy/marker atomicity/保存created_at/age_reference_at/public exportは差分不変。

## テストと証拠

追加test全文をpatchで読む。秒なし/.09/.099999の期限前、.1/.100/.100000の等境界、.100001の後、limit1順序、batch直前.0000等境界変更を実関数/SQLite/payload/markerでassert。タイムキーだけのテストではない。ID tie専用新caseはないがORDERのid clauseは維持。親near.log41PASS確認。probe JSON先頭で42case/1764pairs/mismatches空/outbound0、式と代表zero keyを確認（全pairs独自再計算なし）。native-check.logは等境界fractional purged0/秒のみ別過去例purged1/outbound0を確認。旧P5FAIL36PASSは親報告で当該redログは本担当未読。

## Coverage・未実施・統合注意

F42-W/input/brief/patch全文、probe JSON冒頭、near末尾、native-check.logを読取。既読F40/F41 consumer本体を再利用。git rev-parse/git show/Python hashlibで全P/W照合。独自test/native/oracle/performance/fullverify実行なし。verify:ciは親進行中でPASS先取りなし。新ORDER expressionによるindex順利用喪失/一時sort/CPU増加は未測定で性能無劣化を主張しない。必要な追加検証は代表規模の旧新plan/中央値の有限比較に限定する。

source/Git変更・外部/実データ/secret/spawnなし、本記録のみ書込。commit/patchなし。最終2hashと親verify/native終了記録を統合時に照合。valid UTC前提外のoffset/不正暦日をこのkey単独で安全化するものではなく、VALIDと組合せたprivate fragment契約。全EC機能/全repo日時問題完了には広げない。

## 最終証拠追補
F42-red.log5FAIL36PASS、red-status.json exit1、old-native.log等境界actual1/expected0とold-native-status.json exit1を読取確認。runner0と試験失敗1を区別。verify-ci.log末尾scripts25files263PASS/migration28PASSを確認し、全体exit0は主担当session98730報告に帰属。先のverify未確認を完走ログ照合済みへ更新。

performance-protocol.md/mjs/jsonを読み、canonical500/5000/10000、既存owner/queue index形、limit100、warm3/alternating9、ID一致assertとEXPLAIN取得を確認。中央値P0.075/0.355/0.637ms→W0.210/1.649/3.231ms、全て事前max(2P,P+15ms)内。新式には測定可能なコスト増があり無劣化ではない。これは比較/ソートの限定SQLite microbenchmarkでvalidity/hold/purge-log等を除外、全cron/native/本番SLOを保証しない。独自再実行なし。以前の性能未測定欄はこの限定範囲の親証拠照合済みに更新し、それ以外の未測定は維持する。追加source探索/コード変更なし、製品W固定との親報告。
