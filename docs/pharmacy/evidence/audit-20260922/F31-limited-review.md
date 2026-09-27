# F31 限定 read-only review

ID: F31-LR。担当 audit_db、既存thread再利用。全体fresh-context独立最終レビューではない。
P: `6751d6edcb164dd8e4ac59fc53824a438bfac13d`。W: F31-input.json固定3paths。独自HEAD/P/W照合すべて一致。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `packages/db/src/scenarios.ts` | `1541d6b1fc9ba86be17e057ae45b35b4052b7337f04e21b680a8be3676d46617` | `426f38485a7dcbe38178005281f28a8d6751d827bd83bc962cf3171f3d443b47` |
| `apps/worker/src/routes/messaging/scenarios.ts` | `12f79e752599f6a66a9bf6131fd6a234f06112d59b1159caa8f6ec96762b36dc` | `57d086af32bae23f0e7708659d28866cf23d64fd98d2b42545d93aeab205224a` |
| `apps/worker/src/routes/messaging/scenario-step-scope.test.ts` | `不存在（新規）` | `e069832d0f3d0097f49ab120b3c8e063d1157e609ebdeef30a52846a3e749a49` |

## 結論と保持契約

限定範囲の新規阻害findingなし。既存のforeign-child更新・削除・空updateの返却漏れは、今回のpredicateを通る全SQLで閉じていると静的に判断する（確度:高、実D1での独自実行なし）。元欠陥はgeneric CRMのtenant/parent境界違反であり、薬局本番到達・実被害は確認していない。

1. 旧guardはURLのscenarioだけをtenant/accountで認可する。旧helperはstepIdだけを扱うため、認可済parentに別parent/tenantのchildを組み合わせると境界が抜ける。routeの条件・schedule事前チェックは全更新に必須ではなく、messageContentや空bodyは特に素通りするという元経路を確認。
2. 新predicateは `id = ? AND scenario_id = ? AND EXISTS(parent.id = scenario_steps.scenario_id AND parent.tenant_id IS ?)`。UPDATE/DELETEと最後のSELECTが同一predicateとbind値を使用する。updatesが空ならUPDATEを省略するがSELECTは引き続きscopeされ、未認可行を返さない。更新フィールドは既存固定allowlistのみでparent/tenantの付替えは含まれない。
3. route PUTはURL scenarioIdとserver context tenantIdを渡し、DELETEも同様。body/queryからtenantを採用しない。foreign PUTは404、foreign/不存在DELETEは従来の200/data:nullを維持。正当な更新・空update・繰返しDELETEも従来形式。
4. `IS ?` は明示nullをnull parent tenantに限定する。named tenantへの拡大はない。DB実行時のparent tenant再照合によりguard後のtenant変更にもmutation/返却とも失敗閉鎖。account/staff再認可や全事前readを同一transactionに束ねる変更ではない。
5. optional scope省略は従来id-only predicateを維持。既存3引数update/2引数deleteに破壊変更なし。型の新scopeは構造型で呼べる。現在repo実運用callerは該当2routeのみ、双方scope付与済み。古い外部callerまで自動的に安全化したとは主張しない。
6. schema/migration/API field/serialization変更なし。新helperと旧routeの混在では元脆弱性が残り得るため、修復の成立は新route+helper組合せで判断する。rollbackは形式互換だが安全性まで維持するわけではない。

## 読取 coverage と証拠

適用: root指示、既読packages/AGENTS.md、apps/worker/AGENTS.md再読。
全文読取: 新scenario-step-scope.test.ts、F31-input.json/brief、変更差分。必要部分: DB scenarios.ts UpdateScenarioStepInputからdeleteScenarioStep、Worker routes scenarios.ts PUT全体とDELETE差分、tenant-boundary.ts tenantScenarioResourceGuard、index.ts middleware登録順247–271。実運用caller検索はpackages/apps/scriptsとrepoのts/tsx/js/mjs（生成物・node_modules・evidence除外）で照合。

新10caseは実bootstrap+better-sqlite3のD1 adapter、実Hono/guard/routes/helpersを使用する。別tenant/同tenant別parentの更新と空body返却拒否、削除データ不変、正当更新・空body・繰返し削除、旧helper引数、tenant誤指定update/空update/delete、null互換を確認する構造。tenantはtest middlewareが合成設定し、実認証は含まない。null route認証や並行parent mutationは専用testにない。特にguardがtenantなしでnextする既存構造を全auth安全の根拠にはしない。

親ログF31-red.logは4FAIL2PASS、F31-green.logは3files32PASSを読取確認。元REDは6case段階であり、後追加の4case全てがRED実証済みとの主張はしない。inputのisolated replay PASSは親証拠。独自テスト実行なし。

## 実施コマンド・未実施・残件

`cat`/`sed`で上記本文、`git diff -- packages/db/src/scenarios.ts apps/worker/src/routes/messaging/scenarios.ts`、`rg` caller/guard/ログsummary検索。Python hashlibと `git rev-parse HEAD` / `git show P:path` による全hash照合成功。この記録以外の書込なし。source/Git変更・commit・patch作成非該当。

独自test/build/D1/runtime/外部通信/実データアクセス/spawnなし。親fullverify/生成物/D1実行は進行中で、本記録はそのPASSを先取りしない。SQLiteの相関subqueryをUPDATE/DELETE/SELECTで用いる構造は妥当だが、実Cloudflare D1対応の確認は親の別証拠を要する。

残存concern（新規確定bugではない）: UPDATEとreturn SELECTは別statementであり返却snapshotの原子性は保証しない。guard後のaccount/staff割当変更をこのtenant predicateだけで捕捉しない。事前condition/schedule読取りの全競合や既存NULL認証運用は対象外。全scenario/auth経路PASSとは扱わない。統合時は固定3hashと親の最終必須検証・生成物の記録を照合する。
