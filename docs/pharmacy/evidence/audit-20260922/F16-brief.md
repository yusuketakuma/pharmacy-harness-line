# F16 — webhook紹介送信のtenant境界

FIX/P1/CONFIRMED_BUG（generic consumer、薬局mode本番影響は未確認ではなく当経路が早期returnで抑止される）。P=385bd61f1d352c2fceff30bd8e20cbda4a00ab82、primary/dev。referral-scope-investigation.mdの候補を再現した。

証拠: referral-reproduction-red.log/result.json、既存webhook fixtureのgeneric mode mockでtenant-other routeがtenant-referralの送信へ渡り、禁止assert1FAIL/28filter-skip。外部LINE送信stub。referral-sql-state.jsonは全bootstrap trigger/FK有効のSQLiteでfriend-A.ref_code=route-Bを保存可能、trackingはscope trigger拒否だがrefは残ることを確認。HTTP OAuth全通し/実運用での発生は未実証。

保持契約: same-tenant有効紹介intro/シナリオ/通常accountシナリオ、既存provider retry key/ledger/ACK、不変DB/API。意図的差分は受信event tenantと一致しないrouteを紹介として使用しない、送信直前のtemplate tenantも一致させる。tenant-bound webhookにnull-owner routeを暗黙共有しない（ref_trackingのtenant IS契約と一致）。null-tenant旧DB API自体や保存schemaは変更しない。既存正常fixtureはtenant省略as-neverだったため実型どおりtenantを追加し、意味を維持する。

書込範囲webhook.tsとwebhook.test.ts、周辺読取りentry route DB triggersとLIFFref保存。到達条件: same tenant送信保持、別tenant/null ownerのrouteはtemplate lookup/send無しでaccount scenario設定を変えない、template所属が異なれば送信無し。RED/GREEN、全webhookconsumer回帰/Worker型、統合とartifact。LIFF他attribution consumerは別に再探索を続ける。既存PLANS/evidence保全、外部操作なし。


## 検証中記録

W=F16-input.jsonのP+2paths digest一致。same tenant既存成功assertを保持し、route foreign/nullとtemplate foreignを追加。scope不一致routeはtemplate lookup/送信をせずaccount scenarios取得に戻ることをassert。正常fixtureにtenant_idを追加（実EntryRoute/MessageTemplateのfield、元のas-never省略を補完）。保存schema/DB API/export/signature/ACK/正常provider keyに変更なし。intentional differenceは権限不一致refの利用拒否。

再現コマンド: pnpm --dir apps/worker exec vitest run src/routes/integrations/audit-referral.test.ts -t 'rejects another tenant referral intro'。元webhook.test.tsの紹介testをreferral-reproduction-case.txtの内容に置換した一時testでexit1、実行後一時file削除。providerモック内send実行あり、外部通信なし。SQL状態はPython sqlite3 in-memoryでbootstrap全体→2tenant/account→friend A→template/route B→friend.ref update→ref_tracking INSERT trigger拒否。pragma FK ON、CHECK/trigger弱化なし。

F16-near.log: webhook32/durable16/pharmacy-mode7/lifecycle7=62tests exit0。F16-type.log typecheck exit0。integration-F16-verify.log/result.json:pnpm verify:ci exit0、全workspace型/tests、scripts246/25migration。安全envのみ、Node26.6.0/pnpm11.25.0。Node22 CI実環境未実施。build/artifact起動を実施中。新規runtime/module変更なしなので紹介送信の成果物external E2Eは行わず、compiled Worker起動/入口を検証予定。最終独立レビューは未完、今回self-diff確認を独立レビュー扱いしない。

最終build/artifact: F16-worker-artifact-run.py/build.log/artifact.jsonのVite build exit0、隔離compiled Worker Miniflare runtime exit0。401/薬局generic403/DB不変/list200/webhook413/unsigned200/outbound0。artifact全files SHA256/bytes保存、一時dir cleanup完了。紹介送信自体のcompiled E2Eは未実行、実route+provider stubテストが機能証拠。状態VERIFIED。

INTEGRATED commit 5daae756c7951d9141d09d7335d66ed6a34e1255。2pathsのみ。PLANS/evidence未commit保全、push/deployなし。
