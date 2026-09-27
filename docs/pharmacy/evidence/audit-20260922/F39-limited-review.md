# F39 限定 read-only review

ID F39-LR / audit_db。P `f6a88eedd15094ea52162ac168856647de0aedc8`、HEAD/P/W全4hash一致。再利用thread、fresh全体最終独立レビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/prescriptions/retention-purge.ts` | `20524fb108bfc1288b390ef2fdec032271d57112279b3d9f812c4e2f08e4361b` | `f9c0d6018f3e2940c253220a7b3b64c451c59e0fd7f74bafcf9bbed3254abb96` |
| `apps/worker/src/custom/pharmacy/retention/preflight.ts` | `0b4abd186fc142a7f22c69c9f9b23a8788ffa03b99501eb2264070ff78d4c971` | `5c4030702fb10ff2a86c8cfd3777709b837f8b9b64b4dcf98efc300a492aaffc` |
| `apps/worker/src/custom/pharmacy/emergency-contraception/retention-purge.ts` | `59991aca0ee75714fe8cc451e79002f44e0f48732ef9d9960843b53521eb5fa0` | `d645aa2651f92067da9705a8968fd42616e0e9ecb47aa89a6d46ee47ff1ea15c` |
| `packages/db/test/retention-d1.test.ts` | `2778658fc1a8eb97d779903f299780ae51cafd301c1a51d962e40ba2302ffb5a` | `5228bfef07b74f3d4d6641f0617da97f3eb38cac0e9339b85c5e6683220edae9` |

## 判定・契約

限定差分に阻害findingなし（静的確度高）。旧公開UTC_TIMESTAMP_GLOBの値/exportを維持し、唯一のliteral T手前で分割する。前半は固定幅10文字の数字/ハイフン、後半はT以降で旧末尾*Zをそのまま保持。substr1,10とsubstr11のANDは固定幅prefixの旧GLOBと同じ受入集合になる。秒のみ、不正暦日、末尾wildcardで許す文字列を意図せず厳格化しない。NULLは両GLOB NULL、ANDもNULL、formatSkipped側のNOTもNULLとなり旧NOT GLOB同様に選択されない。空/短い/offset/非ASCII数字は旧条件通り。

5箇所のplaceholder確認: prescription=tenant/account/date/time/cutoff/operation/limit、preflight=tenant/account/date/time/cutoff/MAX+1、EC format=account/date/time、due=now/account/date/time/cutoff/limit、eligible=account/date/time/cutoff/now/limit。旧binding順にtimeだけ追加し、他のscope/hold/cutoff/limit/orderを保持する。

prescription verifiedExecutionと無効clock no-op、候補後のSTRICT_UTC_TIMESTAMP/finite、purgeCandidate/hold/R2保護は差分なし。preflightのdigest入力列とscope/order/MAX_ROWSを維持。ECはaccountごとの選択、format/legal hold count、hold再チェックしたmarker-first+redaction同batch、account失敗の数値集約を維持。新PHIログ/外部操作経路なし。

旧shape自体が不正暦日等を許すことは本packetでは修復していない。特にEC独自ACTIVE_LEGAL_HOLDとF38共有述語の同等性や、全EC削除認可を今回PASSとはしない。条件がnativeで実行可能になることと、全legacy policyが安全という主張を区別する。

## テスト・証拠評価

新native preflight test全文を読む。実bootstrap/Miniflare D1、二tenant/account、4種日時、second-only受入、offset/recent除外、foreign更新によるdigest不変とown更新driftをassert。期待count2/変更digestによりscope・shape・実queryの意味を確認する。NULL/全文字mutationや公開constant exact値はこの恒久testにはない。briefの202case probeは親証拠の説明を読んだ段階で、JSON全件再計算していない。

progressのnear51PASS/native3PASS/typecheck0、旧P1FAIL、fixture準備失敗保全を確認したが担当自身の実行ではない。native preflightだけでprescription/ECの4query実行を証明しないというprogressの区別に同意。実consumer native検証は主担当進行中、未完のまま全5箇所実行PASSとは記録しない。

## 読取・実施・未実施・統合

F39 input/W/brief/progress/patch全文、3product全差分、新test全文、prescription入口/候補後guard、EC入口/account loop/marker-redaction部分を読む。既読retention契約を再利用。巨大consumer全body再監査はしない。cat/sed/git diff、git rev-parse/git show/Python hashlibで4hash照合。周辺出力一部truncateは全diff/既読範囲と区別。source/Git変更・独自test/native/probe/performance/外部/実データ/secret/spawnなし、この記録のみ作成。commit/patchなし。

統合条件: 最終4hashと主担当のactual5query/native/公開constant互換/必要統合checkを結び付ける。substr追加の性能・index挙動は本担当未測定。旧scalar GLOBも先頭range最適化の見込みが乏しいが無劣化を推測しない。brief初期pendingとprogress実装済みの時点差を留意。実本番/release/全retention完了とは主張しない。


## 追加証拠照合による残検証更新

製品W4hash不変を再照合した。F39-consumers-native.json/log、consumer scriptのcompile/export/assert位置、旧P consumer2log/status.json、F39-verify-ci.log末尾およびtest summaryを読取。

実consumer nativeの未確認欄を更新: compiled exportのUTC_TIMESTAMP_GLOB exact値assertが存在。EC実関数はfirst purged1/failed0/skippedFormat1、second purged0/failed0、別accountのpayload保持。処方せん実関数はno-proof no-op、execution付き候補query成功後unknown患者でskipped1/R2calls0/全3file readyをassert。JSON/logともoutbound0。これでpreflight以外の対象4queryの実関数D1検証証拠を確認した。成功R2削除をこのfixtureが証明するとはしない。旧Pは同scriptでEC failed2、処方せんGLOB too complex、status記録は両exit1で、修復前後の差を確認できる。

verify:ci実ログはWorker271files3030PASS、scripts25files263PASS、末尾migration28PASSまで完走する出力を確認。途中の合成failure出力はtest failureと混同しない。全コマンドexit0は主担当session24764の報告による（ログ末尾自体は終了コードを印字しない）。consumer exit0も主担当session51764報告で、出力とassert結果は上記ファイル照合済み。独自実行ではない。

以前の「actual5query/native/公開constant互換/必要統合checkが未確認」は、この追補で読取確認済みに更新する。独自未実施・本番未操作・全体fresh未完・性能未測定等の限界は維持する。EC独自hold日時の別件候補をF39の機能修復に混ぜない。追加レビュー探索や製品/Git変更なし、記録のみ更新。
