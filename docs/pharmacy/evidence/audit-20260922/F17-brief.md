# F17 tracked-link update authority
FIX/P1 candidate; P=5daae756, primary/dev. Scope tracked-links.ts and its tests. Existing PATCH updates before ownership lookup; foreign link may mutate despite 404, and changing account to caller-owned can return success. Tenant-account selector checks supplied account, not existing tracked-link path. Pharmacy tenant allowlist blocks endpoint, generic contract still requires tenant ownership. Expected: check existing ownership and proposed account before mutation; keep legacy null link and same-tenant updates, response shapes, DB schema/public exports. Verify regression RED, near tests/type, integration and artifact if required. Existing PLANS/evidence preserved. No external actions.

CONFIRMED_BUG: F17-red.log 3FAIL/13PASS exit1。foreign updateはDB updater呼出し済の404、foreign→owned移管は200となる。mockは実routeの呼出順と応答を検証し、SQL作用はdb/tracked-links.tsのUPDATE実装で照合。薬局allowlistで当APIが拒否されることは保持、generic HTTP全middleware+実DBの再現ではない。

修復: existing linkとproposed ownerの可視性を更新前に確認。null owner旧契約保持、同tenant/legacy成功assert追加。旧11testsを削除せず5case追加。public symbol/signature/API fields/DB schemaは不変、意図的差分は無権限更新を副作用前に404。F17-near.log 58tests/3files exit0、F17-type.log typecheck exit0、git diff --check exit0。P/W hashes F17-input.json、patch F17.patch。統合verify/build進行中、独立レビュー未実施。

副次候補: tracked-links.ts buildAppRedirectHtmlがHTML用escape文字列をscriptに埋めるため、URLの&が&amp;へ変わり、script終端文字列も残り得る。未再現、F17へ混ぜず次の独立packet候補。公開redirect/薬局modeの到達条件とHTML contextを検証する。

INTEGRATED 87e6987cad9d01148286062a827b7901e0acd60c。全verify:ci exit0、isolated Worker build/runtime exit0、F17-worker-artifact.jsonに成果物hash/bytesとruntime証拠。実APIのgeneric更新compiled E2Eは未実施、機能証拠はroute+DB mock、artifactは起動と主要防壁。Node26/pnpm11、CI Node22未実行。Pからpatchを使い捨てnested repoへapplyしWの2filehash一致、temp削除済。commitは2pathsのみ、PLANS/evidence保持。最終独立レビュー未実施。
