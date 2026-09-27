# F37 限定 read-only review

ID F37-LR / audit_db、既存thread再利用。P `6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b`、HEAD一致。fresh全体最終レビューではない。

| path | P SHA256 | 読取固定W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts` | `b39f1df05e4269117d63aaf6f9f7af3c15c9c71802eb18f464c05016a81a3557` | `07892f35562cf43e5f7d01bbf582263d4ddc9b002acd89400606e448e4644b30` |
| `packages/db/test/retention-d1.test.ts` | `不存在（新規）` | `16a199b8612baac17f5551f77d9e32303f28fdaed9818bc50f694c501d32b475` |

結論: 限定差分に阻害findingなし（静的確度高）。retentionSourceQueryは連続slice(i,i+5)をUNION ALLで包み、配列長が5以下になるまで反復する。各段で順序/termを脱落・重複させず、leaf queryのplaceholder順も保持。34等のsource数でも7group→2groupへさらに包むため最上位だけ大きなcompoundが残らない。source0は成立しない現固定inventoryだが、空配列汎用SQL保証を新設したものではない。

既存patient/owner配列・SELECT内容・scope・bind flatMap順は不変。単一SQL statementのsnapshotを維持し、UNION ALLは重複とNULLを保持。SELECT recorded_at wrapperはfilter/aggregation/LIMITなしで全行を後段評価へ渡す。latestPhiRecordedAtのnull/非UTC/不正/query例外挙動、assessPatientRetention catch→unknownは変更なし。consumer/export/API/期間/schema変更なし。malformed calendar日付の既存候補は今回未解決として分離。

新test全文を読む。既存WranglerからMiniflareをresolveしbootstrapを実D1へ適用、old source→released、foreign除外/owner不一致unknown、owner最新→held、patient最新→held、不正source→unknownを検証。direct latestPhiRecordedAtを呼ぶためquery例外がassessmentのunknownで隠されず検出できる。finally dispose、outboundServiceで外部を阻止し0をassert。全33sourceを各1行seedするテストではなく、全queryの実engine compile/実行と代表patient/ownerの意味を保証する構造。NULL専用fixture・最後の各source bindを独立検証するcaseはないが、構成差分はsource/bindを編集しておらず静的保全を確認。

親near-final.log末尾は21PASS、red.log冒頭はtoo many termsによるfailureを読取。担当自身はtest/native/perf/fullverifyを実行していない。native実行はlocal workerd/D1の証拠であり本番Cloudflare稼働証明ではない。採用5は親probeで成功した制約内の値で、公式上限値確定とは主張しない。性能閾値PASSは親申告でログ未読、最終compilednative/verifyは進行中。

読取: F37 brief、legal-hold.ts diff全体、新retention-d1.test.ts全文、red/near-final該当部。既読DSH/F36のsource inventory/consumer契約を再利用、他workflowへ拡大なし。git diff/cat/head/tail、git rev-parse/git show/Python hashlibでP/Wを記録。source/Git変更・独自外部/実データ/secret/spawnなし、作成物はこの記録のみ。commit/patchなし。

統合時はW2hashと親のcompilednative/required verify/性能結果を照合。全source inventoryの正式分類網羅と全retention safetyをこの修復のPASSへ拡張しない。初期2群失敗はbriefに残されており、最終階層helperの証拠と区別する。
