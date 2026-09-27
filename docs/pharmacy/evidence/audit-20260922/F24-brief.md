# F24 FIX — 有効期限通知の待機処理停滞

RUNNING. P=75cf0b78894dc92fa61620401bbd1b796b33c206. /root dev checkout。CONFIRMED_BUG P2、validity-queue-progress-case/log/result: actual processor2回で同じ50件paused、別tenantの51件目が未選択。

Scope: growth-loop/validity.ts、focused queue test、既存validity mockのschema読取対応、新029_custom_081+paired test、公式生成bootstrap/meta、exact migration manifests。既存claim UPDATEでnullable checked timestampを同時記録し、releaseClaimでは消さず、ORDER BYに使う。余分な行UPDATEは追加しない。旧schemaでは旧query/claim、旧caller/oldwrites/API/date/status/retrykey/15minlease/expired review/payload保持。現在active tenant/accountをclaim時にも照合。metadata時刻後退なし。

検証条件: pause/failure/missing credential50→51、claim競合、送信再開、旧schema/旧書込/移行保全、期限日不変、全verify:ci、compiled cron realD1。性能N50/500/5000各3回、old/newの増分中央値≤50msを事前上限（localのみ、remoteD1未測定）。全体fresh最終レビュー未完。

## Verification

Source repro P: validity-queue-progress.log 1PASS means bug reproduced (100calls same50/otheraccount unselected). F24-near.log exit0,16PASS/2files (9new SQLite cases,7prior). RealSQLite current+oldschema, all FK/check/trigger on. Oldschema fallback retains prior starvation until029 applies, explicitly not fixed on oldschema. Current perclaim checksactive mapping/account so postread revocation stops processing. Monotonic metadata; claim conflicts no new metadata; send sent/failed/skipped and date fields preserved. Positive resume 50confirmed stamps, other outcomes no sent stamp.

integration-F24-verify.log pnpm verify:ci exit0 including paired migration test, allworkspace types/tests/scripts, additive migration checks. Existing validity mock excludes schema introspection from business-query position assertions; assertions retained. Eight manifest expectations append029. Generator logF24-generate exit0, historicalmigrations unchanged,bootstrap/meta officially regenerated.

F24-worker-artifact-run.py build0/runtime0: isolated actual compiled6h cron, localD1 full bootstrap,51validities. Missing synthetic credentials→release claim but checked50 then51 across ticks, verified/date state preserved, external0. Existing HTTP/Meet failclosed guardsPASS. Artifact hashes/bytes F24-worker-artifact.json. Realdelivery not performed.

F24-performance.log exit0,1benchmarkPASS/9filtered skips (permanent9alreadyPASS). FixedN50/500/5000,3runs old/new: median2.284→2.385ms,2.414→2.769ms,5.055→5.837ms; increases<50ms predeclared. Claims50/tick in both, no additional rowUPDATE, existingrelease50 stayssame. Extra schema read1/tick, index storage/maintenance added. SQLplan recorded JSON; no generalized index/production performance claim. RemoteD1 latency/cost unmeasured. Temporary benchmark source/DB/build/runtime removed after matching savedcase; evidence retained.

Public field check: prescriptions/repository.ts validitydetailSELECT lines953+ explicitly enumerates existing fields, adminacceptSELECT1061+ explicit too. growth-loop metrics and legalhold SELECT explicitcolumns, metadata not added to API payload. Existingupsert uses named columns and preserves new metadata; migrationoldwrites tested directUPDATE/row-preservation, no lockstep deployment. Payload/template/date-calculation unmodified.

F24-input.json/patch: isolatedP+patch reproduces all15W SHA256, no unintended paths. Node26/pnpm11; CI Node22notrun. UIunchanged/notapplicable. No PHI/secret/prodread/remotechange. Required fresh final independent review still outstanding globally; optional bounded packet review pending.

SQL planの限定結果: N50/500/5000のいずれも新expression indexは選択されていない。indexによる高速化を主張せず、追加storage/write-maintenanceと実環境planner差を未測定事項として残す。ローカル性能は追加index込みで上限内。

## Checkpoint

INTEGRATED local commit fa43ab1e53a60e6154ad528a7ee2453e0774cbf4. F24-limited-review.md全文受領、全15hashと局所/full/build/runtime成功を照合。旧schema互換はmetadata関連ORDER/SETを省略する意味であり、active tenant/accountのclaim再確認は旧schemaにも意図的に追加される。全SQLのbyte同一を主張しない。全体Goal/fresh最終独立レビューは未完。
