# F40 限定 read-only review

ID F40-LR / audit_db。P `dc01f9b2064c466d453f8ffbba2ce8cb30dfa585`、HEAD/P/W2hash一致。再利用thread、fresh全体最終レビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts` | `d645aa2651f92067da9705a8968fd42616e0e9ecb47aa89a6d46ee47ff1ea15c` | `a0533047cda0f07326554b0a75fd4a71225d90d1cb1f853324dd9643511dc51a` |
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.test.ts` | `4d3a72d08be819b1e5acb9dc253b406a255a887df549d472ddff3d90dc3f271d` | `e413e89766105b8a8bf51ed038d9b9de6214c6552b0ed5e9a67b18405c77126b` |

限定差分に阻害findingなし（静的確度高）。ACTIVE_LEGAL_HOLDは既存account/owner/hold1条件を保ち、解除の証拠をlength24+strftime正規化一致+<=nowへ限定する。NULL/不正でSQL NULLになってもCOALESCE0→NOT1により保留。正規expired・exact nowは解除、1ms未来は保持。有効閏日は受入、不正2月30日/24時は元値不一致。status条件を追加せず、hold0や既存独自政策を変えない。共有DSR述語の全規則をimportしていないことを確認。

同一定数をdueのhold flag、eligibleのNOT EXISTS、marker INSERT直前のNOT EXISTSで利用する。placeholderは従来どおりnow1個、各3caller bindの位置変更なし。account別retention_days/limit/order/metric/原本ではなくpayload+flags redaction/marker-first同batchが不変。holdが選択後batch前に到着する場合もmarkerを作らずredactionを止める。候補後raceでskippedLegalHold増加を保証する変更ではなく、既存metric semanticsを維持。

新parameter caseはexact now/futureを残しvalid leap、invalid各形を追加。実関数の結果/PHI payload/flags/marker件数をassertし、全件無条件blockになる誤修復もvalid例で検出。raceをnull/Feb30へparameterizeし、batch直前insert後payload/flags/marker不変をassert。全D1/auth/実患者への安全証明ではない。

読取: F40 input/W/brief/patch全文、test310–376、定数利用/bind箇所検索、F40-consumers-native.jsonとscriptのfixture/assert箇所、near summary、旧P unit/native/status。native記録はcompiled実関数/fullbootstrapでFeb30保留、first/second purged0、別account保持、outbound0。専用native race/全日付parameterを実行するscriptではない。近傍3files66PASSをログ確認。旧Pログは別に読取したが本担当の実行ではない。verify:ci進行中は成功と扱わない。

実施cat/sed/rg/git diff、git rev-parse/git show/Python hashlib。source/Git変更・独自test/native/perf/外部/実データ/secret/spawnなし。この記録だけ作成、commit/patch非該当。最終2hashと親old-P比較/verify/native終了記録を統合時に照合する。性能計測は本担当未実施。F39のshape受入/別retention制度を本packetで変更せず、全EC機能/全DSR policy完了とはしない。

最終証拠追補: 旧P unit実ログ5FAIL15PASS、native実ログactual purged1/skippedLegalHold0（期待purged0/hold1）、old-status.json両exit1を確認。F40-verify-ci.log末尾のscripts/migration成功とtest summariesを追加読取し、進行中欄を親最終exit0報告(session71989)と完走ログ照合済みに更新。ログ自体にshell exit値の印字はなく、exit0の帰属は主担当session記録。W変更なしとの親報告、独自実行なし。
