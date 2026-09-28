# F21 FIX — 継続案内の通知待ち停滞

Status RUNNING. P=d595215. Owner /root, existing dev checkout. Confirmed repro: continuity-queue-progress-final.log/result.json; first50 skipped rows block another tenant indefinitely.

Write scope: continuity/next-intake.ts, focused queue regression; new additive028_custom_080 migration + paired migration test; generated bootstrap/meta via official generator; exact migration manifest expectations in existing DB/update-engine tests. Read dependency: continuity notifications, shared approved sender, scheduled index, F20 scheduling implementation.

Preserve: old schema query/row shape, previous-version writes, clinical version/status/reminder_at, accepted→active audit, per-tick limit, tenant/account authority, delivery retry keys and PHI-free sender. Intentional change: round-robin retry eligibility via internal monotonic checked timestamp, set before activation or delivery. No new public API fields. Old schema retains existing starvation until migration.

Acceptance: real SQLite50→51 progress across pause/failure/credential missing; resumed delivery; accepted transition; scoped stale metadata rejection; old schema and old writes; paired migration/FK; full verify:ci; compiled isolated cron with synthetic DB/no network. Performance predeclared: N50/500/5000,3 repetitions, new median overhead ≤50ms at each N locally, bounded50 writes/tick; remote D1 latency/cost unmeasured. Fresh final independent review remains outstanding globally.

## Verification evidence

- Source defect reproduced before edits: continuity-queue-progress-final.log exit0/1PASS; 100 calls target first account, same50 rows across two6h ticks, foreign_key_check empty, external0. Initial fixture unique active patient conflict preserved separately.
- `pnpm --dir apps/worker test src/custom/pharmacy/continuity`: F21-near.log exit0,38PASS/6files, including12new regression cases. New tests preserve oldrow shape and oldschema SQL, paused/failure/missing credential progress, resume/accepted audit, post-read tenant suspension/account disable/version/end/write-error, monotonic timestamp.
- `pnpm verify:ci`: integration-F21-verify.log exit0; Worker265files/2926tests, DB102files/479tests including paired custom080, all other workspace types/tests/scripts/migration policy pass. Temporary benchmark file was created after the Worker suite completed and is absent from that run. No test expectations weakened;8 exact manifest lists append028 while preserving old entries.
- `python3 F21-worker-artifact-run.py`: build0/runtime0, F21-worker-artifact.json records file hashes and bytes. Compiled6h scheduled handler, real localD1 full bootstrap and51 synthetic expectations: checked50→51, all51 active/version1, credential absent skip, external0. Existing auth/HTTP and Meet credential-fail checks pass. No realdelivery or production claim.
- Bounded performance: F21-performance-final.log exit0,1benchmarkPASS/12filtered skip (the12 permanent cases alreadyPASS above). N50/500/5000,3iterations each old/new, medians0.428→1.405ms,0.589→1.961ms,2.655→3.881ms. Extra metadata writes50/tick, local increase<50ms at allN. First performance attempt failed due to benchmark loop variable shadowing tick(), corrected only temporary harness; failed log preserved. Both query plans use the pre-existing due index and temporary ORDER BY B-tree; new expression index is not used in these fixtures, no query acceleration claim. Remote D1 latency/cost unmeasured.
- Patch: F21.patch, F21-input.json records all14 P/W paths and SHA256; isolated nested-git P+patch reproduces allW hashes. Temp source/DB/build/runtime/benchmark cleanup complete. No .env/prod reads, push/deploy/external writes.
- CI Node22 unrun; local Node26/pnpm11. Required fresh final independent review remains globally unavailable; limited existing-thread packet review pending. Public exports/signatures and notification payloads unchanged, internal SELECT excludes new column. Clinical timing/status/version only change through existing transitions. Migration is additive; old app writes remain valid, old schema fallback preserves old queue behavior until migration.

## Checkpoint

INTEGRATED local commit 24c336a50466d0afd8190576efb5a4ca529a880e. Limited review F21-limited-review.md received/read/hash-matched all14paths; no new confirmed defect. DB-write permanent failure and concurrent cron dedupe remain explicit limitations. The existing child is complete/unclosed and not fresh final review.
