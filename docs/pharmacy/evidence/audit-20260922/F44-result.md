# F44 / FIX / INTEGRATED

P `6c940754b3661df5eeeda1dedf46612dfa256137` → I `49ee0d2162e10761403b7d4fc8f1e0380a171d26`。主担当、dev、現在の作業ツリー。変更は `apps/worker/src/index.ts`（onError登録1行+import）、新規 `apps/worker/src/lib/app-error-handler.ts` と同テストのみ。F44-commit.json参照。

未捕捉例外がHono既定handlerの `console.error(err)` で例外本文・stackをログへ出す懸念（unhandled-image-error-concern.md）を、app全体の `onError` で修復。既定handlerと同じく `getResponse` を持つ例外（HTTPException・duck-typed）はそのresponse body/status/headersを転送し、それ以外は固定イベント `unhandled_route_error`（route pattern/method/statusのみ、allowlist logger経由）を出して従来通り `text("Internal Server Error", 500)` を返す。sub-appに独自onErrorは無いことを確認済み（既定handlerのsub-appは親handlerへ委譲）。公開API・応答body/status/content-type・middleware付与header・保存形式は不変。

検証: Hono既定handlerで合成sentinelがconsole.errorへ出るRED 1FAIL → 新handler 3PASS（固定500/middleware header保持/既定応答と完全一致/HTTPException 418・duck-typed 409+header転送・console無出力）。Worker全体272files 3064PASS、typecheck exit0、Worker vite build exit0、diffcheck0。F43のGET画像実bundle probeへ新handlerを登録したF44-image-probe.mjs/jsonで status500/body不変/sentinel非出力/R2呼出1。

未実施: cron(scheduled)やwaitUntil内の例外は対象外。Node22、nativeWorkerd、実provider、全Worker認証を含む配布物実行、本番、fresh-context全体最終レビューは未実施。全体coverageはPARTIAL維持。外部操作なし。
