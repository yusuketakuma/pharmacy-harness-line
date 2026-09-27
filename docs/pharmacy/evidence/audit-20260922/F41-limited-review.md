# F41 限定 read-only review

ID F41-LR / audit_db、P `2f40741e0510c8788418b06a5069b2467099a072`。HEAD/P/W全hash一致。再利用thread、fresh全体最終レビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts` | `a0533047cda0f07326554b0a75fd4a71225d90d1cb1f853324dd9643511dc51a` | `d5720befff717a4f51ba6b87002aeb1112ccd2c72a40c411eba621927e91e625` |
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.test.ts` | `e413e89766105b8a8bf51ed038d9b9de6214c6552b0ed5e9a67b18405c77126b` | `760772144ef6f3071791616cb1cb2ea8b37b4cb73bbc4e7a44b826e33b87da0e` |

限定差分に阻害findingなし（静的確度高）。VALID_CREATED_ATは旧固定prefix/suffix GLOB後、19文字までの秒単位時刻にZを付けたstrftime roundtripを要求し、不正暦日/24時を拒否する。SQLの `||` は比較より強く結合するため左右のprefix||Z比較となる。fractionは秒なし20文字、または22文字以上かつ20文字目dot、21文字目から末尾Z手前までが数字のみで非空。旧valid秒のみ/.1/.999999等を保持し、正当高精度fractionをSQLite丸めで翌秒へ移さない。

COALESCE(...,0)でNULL/無効関数結果はinvalidへ。COUNTのNOTでNULLも不正数へ入る点は旧NOT GLOBのNULL不計上から意図的強化であり、「NULL意味も完全不変」とはしない。候補はinvalid0として除外するので誤redactionに開かない。calendar-invalid/suffix不正を除くのはRETENTION_MATRIXのkept/count契約に対応。

COUNT/due/eligibleで同fragmentを用い、invalidがLIMIT枠を消費しない。旧due/eligibleのdate/time binds位置は同じ、markerだけuuid/retention_days/now/id/account/dateGlob/timeGlob/cutoff/holdNowへ増える。account/owner/hold/既存status/metric/order/limit/期間は差分不変。marker INSERTにvalid+cutoff再確認があるため、選択後に不正/新しいcreated_atへ変わってもmarker未生成、後続UPDATEのmarker条件でpayload保全。batch外任意writerまで排他する新保証はない。

テスト追加全文をdiffで読む。valid4/invalid5、invalid先頭limit1、選択→batch時不正/現在日時へ変更2case。結果件数だけでなくpayload/risk flags/marker不変をassertし、valid例で過剰blockを検出する。旧null hold等は先行F40範囲を再利用。native JSONはFeb30保持とoutbound0であり、全valid fraction/全raceのnative実証には広げない。near32PASSのログを読取、旧RED8FAIL24PASSは依頼報告で本担当当該ログ未読。verify:ci進行中を成功扱いしない。独自テスト実行なし。

残存concern: 可変fraction/秒のみのraw timestampを許す一方cutoff/ORDER BYは従来text比較。例えば等瞬間の .1Z と .100Z は比較一致せず、秒なし形式も同秒fractionとは文字列順が異なる。今回新規導入ではなく、不正日時排除のscope外として親へ通知済み。全時系列整合性が直ったとの主張をしない。必要追加検証はcutoff同秒の0/1/3/6桁fraction比較を小parameter表で確認する程度に限定し、既存acceptanceの無断変更はしない。

読取F41-W/input/brief/patch、native-check.json、near.log末尾。既読EC body/marker/consumer契約を再利用。migration glob探索はno matchesで失敗し、NULL schema制約を今回再確認済みとはしない。git rev-parse/git show/Python hashlibで全hash照合。source/Git変更・独自test/native/perf/外部/実データ/secret/spawnなし、記録のみ作成。commit/patchなし。統合時最終2hashと親verify/native終了結果を照合し、全EC/全体freshレビューへ拡張しない。

親追加情報: schema created_atはNOT NULL（本担当未再照合）なのでNULLは通常永続契約では非到達。特にcutoff `.000Z` に対しsource `.0000Z` は同瞬間でも文字列が小さく早期候補となる別件境界懸念がある。F41 scope外として保全し、native確認は主担当の次packetへ。nativeのvalid .999999Z/秒のみZ追加検証は進行中で、本レビューではまだPASS認定しない。

## 最終証拠追補
F41-native-check-final.logと更新F41-native-check.jsonを読取照合。invalid保持purged0→fractional purged1→seconds purged1、outbound0を確認。依頼のF41-native-check-final.jsonは不存在で、実在する更新JSON名はF41-native-check.json。この読取失敗を記録し、成功ログと混同しない。旧P F41-red.log8FAIL24PASSとred-status.json exit1、old-native.log actual purged1/expected0とold-native-status.json exit1を確認。runner自体の終了0と回帰失敗1を区別する。F41-verify-ci.logは末尾scripts25files263PASSとmigration28PASSを確認、全体exit0は主担当session92219報告。native exit0もsession24762報告であり担当独自実行なし。先の最終native/verify未確認欄をこの証拠照合で更新する。製品W不変との親報告、追加source探索/編集なし。F42同瞬間fraction境界は親native再現済みという連絡を記録するが、そのlogは本追補では未読で別packetへ委ねる。
