# F37 受入記録
F37 FIX/CONFIRMED_BUG/P2、primary/dev。P=6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b、H/Bはbaseline.json。W2pathsはF37-W.json、F37.patchを隔離Pへ適用してW再現済。

## 根拠・変更・契約
33sourceのflat UNION ALLが実local D1でtoo many terms in compound SELECT。latestPhiRecordedAt例外がassessPatientRetentionでunknown化し、古い合成PHIしかなくても正常判定できなかった。新native回帰1FAILで確認。2つの大きな群ではなお失敗したため、5termずつ階層化し各compoundを5以下にする内部helperへ変更。
全33source/leaf SQL/66bind順/UNION ALL重複・NULL/単一statementのsnapshot/既存API・公開export・inventory・schema/保持期間・日時規約を維持。取得不能や不正sourceは従来通りunknown。意図的差分はnativeで有効queryとして実行できること。既存tests削除・緩和なし、新native1caseを追加。新dependency/package設定/entrypoint変更なし、既存Wrangler同梱Miniflareをtestで使用する。

## 実行証拠
共通env -i PATH/TMPDIR LANG=C.UTF-8 CI=true NO_COLOR=1、nativeはWRANGLER_SEND_METRICS=false。Node26.6.0/pnpm11.25.0、全操作合成/ローカル。F37-execution-status.jsonにterminal session/exit。
- pnpm --filter @line-crm/db test test/retention-d1.test.ts: 旧P1FAIL（F37-red.log）。直接queryを呼ぶためunknown fallbackで欠陥を隠さない。
- 2群候補ではnative1FAIL/既存20PASS（F37-near.log）。F37-limit-probe.mjs/jsonで5term成功、10term失敗、5term×2/4group成功、×7group失敗。正確な上限値は公式保証としていない。
- 最終native新1+既存DSR20=21PASS（F37-near-final.log）。実全bootstrap/全source queryをcompile/execute、古い記録released、foreign除外、owner不一致unknown、owner新記録held、patient新記録held、不正sourceunknown、egress0。全source各1行の網羅fixtureではない。
- pnpm verify:ci exit0（F37-verify.log）: 共有build、workspace型・tests、DB104files487PASS、Worker271files3020PASS、Web55files267PASS/LIFF28files205PASS、他workspace成功、scripts25files263PASS、28migration checker成功。
- F37-native.mjs: actual compiled DSR routes/repository + fullbootstrap/localMiniflareD1、erasure create→verify→assess released→resolve、stale409、新規受付世代8、exact/owner一致、egress0。F37-native.json/log exit0、artifact96905B/SHA256374e43daad3ac8c4d62c239d5375da6cdcf6e627903408baea5be718061e77b4。F36で残った正常erasure経路のlocal runtime不明を解消、実R2削除はこのworkflow自体の操作ではない。
- F37-performance.mjs/json: 同一better-sqlite3/bootstrap/source/合成50/500/5000messages、warm3/交互9回。中央値P→W(ms) 0.189→0.201 / 0.290→0.316 / 1.408→1.339、事前W<=max(2P,P+15ms)内。query1/binds66不変、7055→7289bytes。全9export+33inventory完全一致。計測は本番D1 latency/大容量/並行負荷の保証ではない。初期scriptにbrace構文ミスがあり修正後のみ計測。
- git diff --check0、isolatedpatch2path0。F37-limited-review親全文/2hash確認、阻害findingなし。担当のsource数誤記34は33へ訂正済み、親も確認。再利用threadでfresh最終全体reviewではない。

## 制約・再探索
native実engineを通常DB testへ組込み、汎用SQLiteだけでは検出できない再発を防ぐ。retentionSourceQueryは現在の非空inventory用内部helper、任意SQL汎用builderではない。query数/保持対象/consumer unchangedを再照合。
参照 https://developers.cloudflare.com/d1/platform/limits/ はSQL/bind等の制限を確認する補助。compound制限の根拠はF37 local実測であり公開資料の未記載数値を補完していない。Node22/本番Cloudflare/全auth/全retention安全/fresh全体最終reviewは未実施。malformed calendar日付の技術的concernはdata-subject-hold-review.mdに残る。PLANS/evidence保全、製品2pathsのみlocal commit予定、push/deploy/外部変更なし。

統合済: 3158e7c337a3d43022b1db6fd0a4ce0fc4877257（2paths）。
