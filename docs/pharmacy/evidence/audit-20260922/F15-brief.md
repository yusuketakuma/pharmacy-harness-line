# F15 webhook bodyの有界読取り

状態RUNNING（再現準備）。P=df98ebebb6b134372d262fd32ba05ec66330998e、primary/dev。対象webhook.ts/testのHTTPbody読取り。契約:既存1MiB上限/413と署名対象の元body/tenant認可を維持。現行text()後にbytecountするため上限超過前に全入力を消費する具体経路あり。F13と同種だが別入口。まず2MiB合成stream/欠落・過少Content-Lengthで超過後読取り停止をassert、保護前にREDを得る。外部通信・実payloadなし。

修正は新しい上限や機能を追加せず早期停止を実装する範囲。設計未確定。原文byte/decode/既存署名の互換、正常multi-byte/chunk境界、close/cancel例外の検証が必要。共通readerを採用する場合はF13旧export互換とテストを維持。台帳の全体PARTIALはそのまま。

再現RED: header欠落/1の両caseで9pull（全2MiB+EOF）まで読み、上限超過後停止期待5に失敗。CONFIRMED_BUG/P2。共通readBoundedBodyをlibへ抽出し既存画像readerは10MiB固定wrapperでsignature/返値/例外を維持。webhookは1MiBで同reader→TextDecoder、元Response.text相当UTF8デコードを保持する方針。追加依存なし。有限書込範囲はwebhook.ts/test、lib/read-bounded-body.ts、prescriptions/image.ts。必要追加testsは共通reader/画像consumer。module追加のためbuild/artifact/旧exportのconsumer検証が必要。


## 最終受入

W=F15-input.jsonのP+4paths SHA256。F15-red.logの2FAIL/25filter-skipは現行全読取りを検出。F15-final-near.logのwebhook29+image/routes=102tests PASS、F15-type.log typecheck exit0。新回帰4case: header欠落/過少で5pull時点cancel、1MiB丁度の日本語/絵文字分割+BOM有無で署名textをResponse.text基準と完全一致。既存画像の10MiB・binary/hash・空body/readerror/lock・413回帰がPASS。元25webhooktests削除/弱化なし、新skip追加なし。

integration-F15-verify.log/result.json:verify:ci exit0、全workspace型/testsとscripts246/25migrations。F15-worker-artifact-run.py/build.log/artifact.json:合成configでbuild exit0、元source無しのcompiled WorkerをMiniflare起動しwebhook超過413/通常unsigned200、401/薬局generic403/DB無変更/list200/outbound0を確認、runtime exit0。artifact全files bytes/hash保存。一時runtime/build削除済み。実署名つき外部LINE通信/本番は未実施。artifactのpull数は未計測、早期停止は合成Request実route回帰で検証。

互換確認: public image reader名/引数/Promise返値/10MiB定数を維持するwrapper。共通readerに同じ読取り/cancel拒否抑制/readerror伝播/finally releaseを移し、呼出固有のmaxだけ引数化。new moduleはtop-level副作用/依存なし、import循環なし。webhookの1MiB/413 body/署名入力/tenant selectorとsignature照合/ACK/inboxは不変。bodyのbounded読取りのみ意図的変更。worker indexではwebhookがbody読取りのある/api tenant guards外にあることを確認。時間・memory性能向上を数値で主張しない。超過後未消費入力を打切る機能保証。

self diff/契約確認は実施、packet固有子レビューは未実施（最終fresh-context全体レビューは依然未完）。FIX内の必要な共有化であり独立REFACTOR達成値を水増ししない。状態VERIFIED、4pathsのみローカルcommit予定。既存PLANS/evidence保全。

Commit 385bd61f1d352c2fceff30bd8e20cbda4a00ab82、状態INTEGRATED。indexの4paths一致を確認してcommit。push/deployなし。
