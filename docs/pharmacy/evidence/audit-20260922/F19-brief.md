# F19 pharmacy Meet cron dispatch
FIX/P1 candidate. P=412c6c9 primary/dev. Scope index.ts and new scheduled-meet-reminders.test.ts. User project contract requires day-before/hour-before Meet reminders. Dedicated service supports approved pharmacy template/encrypted credential, but index only invokes inside runGenericCron, false for pharmacy. Move existing invocation outside generic-only gate, preserve refresh-before-reminders, error isolation, original schedule frequency and options. Keep generic jobs gated. Service/DB/API/templates unchanged; F12 generation semantics preserved. RED actual scheduled entry with downstream stubs, service regressions, full verification/artifact. No real data/external actions.

CONFIRMED_BUG。F19-red.log: scheduled entryをminute tick、generic=falseで呼び出し、Meet processor未呼出しにより2FAIL。F19-near.log: new2 + service/routes/cron-access合計33PASS/4files。service側既存testsはpharmacy template/credential拒否/同一登録再送防止等を維持。新testは成功時のrefresh先行とproxy/key options、generic booking未呼出し、Meet failure後の他薬局job継続、外部fetch無しをassert。

実装は既存Meet try/catchだけをgeneric gate外へ出し、前後の汎用booking/webinarの順序とgateを保持。呼出回数・now・proxyDispatch・credential key・service retry/generation/schema/APIは不変。薬局senderを汎用senderへ置換しない。

統合: integration-F19-verify.log verify:ci exit0（型検査含む）。F19-worker-artifact-run.py build0/runtime0。compiled index.jsを別harness入口からscheduledへそのままdispatchし、bootstrap全制約有効の合成pharmacy DBに期限到来Meet rowを投入。pending→failed/retry_count1/credential unavailableとなり、processor到達とcredential無し拒否を確認。outbound0。harnessだけ追加しcompiled source未改変、prod HTTP route追加なし。F19-worker-artifact.jsonに成果物hash/bytes、F19-worker-artifact-smoke.mjsにfixture/検証。実LINE送信成功の証拠ではない。

P/W hashes/F19.patch保存、新test含むpatchを隔離Pへ再適用してW一致。Node26/pnpm11、CI Node22未実行、最終独立レビュー未実施。旧F12のcron記録は引数だけを確認しgateを見落としていたため、本F19で入口回帰を追加。

INTEGRATED fb6ab3452d047befd539c6c965187ab0f7425b70。2filesのみcommit、既存PLANS/evidence保全。push/deploy無し。
