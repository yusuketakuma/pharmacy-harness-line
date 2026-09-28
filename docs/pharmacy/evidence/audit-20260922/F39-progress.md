# F39 checkpoint — RUNNING

P f6a88eedd15094ea52162ac168856647de0aedc8, branch dev. Four product/test paths recorded in F39-input.json and F39-W.json; F39.patch reproduces W from isolated P (F39-patch-check.json). Not committed. Existing PLANS.md diff and audit evidence preserved.

Changes: split 77-byte GLOB into fixed date/time parts (42/35) in all five candidate/filter query sites across three consumers. Positive AND and negated whole conjunction preserve legacy SQL NULL behavior. Existing public constant value/export retained. Account/tenant binds, date cutoff, execution proof, hold checks, limits, order, R2 and redaction operations unchanged.

Verification:
- Worker three related suites: 51 PASS, exit 0, session 97093, F39-near.log.
- Native D1 suite: 3 PASS, exit 0, session 8506, F39-native-test-pass.log. Added full-bootstrap, two-account preflight regression with second-only UTC legacy acceptance, offset/recent exclusion, foreign mutation digest stability and own mutation drift. No outbound calls.
- Isolated P with same final regression: 1 FAIL expected due to LIKE/GLOB pattern too complex, two other tests not selected; runner session 99879 exits 0 but vitest exit 1, F39-red-final.log/status.json. The initial old-P run hit fixture position constraint and was not accepted as defect reproduction.
- Fixture development failures retained: F39-native-test.log invalid synthetic R2 prefix; F39-native-test-final.log five positions exceed schema maximum four. Fixed fixture only. No constraint relaxed.
- Worker typecheck exit 0, session 35208, F39-typecheck.log.
- git diff --check exit 0. All four current path diffs inspected. No public exports removed or changed.

Remaining before VERIFIED/integration: native execution of prescription candidate selection and all three emergency query sites (preflight native test alone does not prove these consumers); focused previous export compatibility assertion; proportional integration verification; limited independent review; any compiled artifact/consumer evidence needed by final scope. Preserve valid passing evidence unless affected by later edits.

Next: reuse existing prescription/emergency synthetic fixtures to exercise actual functions on D1, verify old-P failure and W behavior, then freeze/review and checkpoint. Global coverage remains PARTIAL and fresh final independent review plus old OSS trusted-hash provenance remain unresolved. No production/release claim.
