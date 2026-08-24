# Pharmacy field-level encryption design

Status: v0.32.0 の development 実装と synthetic test は完了。production の secret
投入、backfill、scrub、restore、rotation、deploy は `NOT_RUN` であり、production
readiness は主張しない。

## v0.32.0 implementation status

| Boundary | Development state | Production state |
| --- | --- | --- |
| AES-256-GCM envelope、AAD、nonce重複拒否 | `PASS` (`intake/encryption*.test.ts`) | `NOT_RUN` |
| encrypted-write-first、mixed read、malformed envelope fail-closed | `PASS` (`intake/repository*.test.ts`) | `NOT_RUN` |
| bounded backfill、coverage digest、resume | `PASS` (`intake/migration*.test.ts`) | `NOT_RUN` |
| write freeze、CAS scrub、verified restore | `PASS` (synthetic D1) | Human Gate未実施 |
| named approval、別executor、expiry、scope/fence | `PASS` (`recovery/operations*.test.ts`, `data-protection-routes*.test.ts`) | `NOT_RUN` |
| key rotation / rewrap | `UNVERIFIED` | `NOT_RUN` |

既存のadditive table `custom_040`/`custom_041`を再利用し、v0.32.0では
`custom_056`のrecovery operation・execution fence・verified backup generationを
Human Gateのauthorityとして追加した。request bodyの`approvedBy`等は拒否し、
認証済みPlatform admin principalだけをapprover/executorとして記録する。

## Scope and non-goals

The first encrypted field is `pharmacy_patient_intake_responses.answers_json`. It can contain allergy, pregnancy, breastfeeding, medical-history and free-text notes. `patient_snapshot_json` follows in the same rollout because encrypting answers while retaining an identifying snapshot would leave the record only partly protected.

The bounded fulfillment `reason_codes_json` and `requirements_json` remain plaintext: their schema explicitly excludes clinical notes and the server queries requirement codes. R2 objects remain protected by private-bucket access control and tenant-scoped object lookup; application-level streaming encryption is a separate design because it changes upload, print, range-read and cleanup behavior.

## Envelope

- Algorithm: AES-256-GCM through Web Crypto.
- Root secret: a new `PHARMACY_PHI_KEY_V1`; do not reuse `LINE_CREDENTIAL_KEY_V1` or an authentication HMAC key.
- Per-record nonce: 96 random bits, never reused with the same key.
- AAD: `tenant_id`, `line_account_id`, `owner_friend_id`, `patient_id`, response `id`, `schema_version`, field name and envelope version.
- Stored metadata: `nonce`, `ciphertext`, `key_version`, `envelope_version`, `encrypted_at` and the source revision. No deterministic lookup digest is created because answer content must not be searchable.

The implementation reuses the validation, Web Crypto and versioned-key pattern in `line-credentials.ts`; it does not reuse the LINE credential table or key.

## Additive storage and migration

Create a companion table keyed by `(response_id, line_account_id, owner_friend_id, patient_id)` with a composite foreign key to the intake response. This keeps the applied intake migration immutable and permits a safe phased rollout.

1. Deploy dual-read code: encrypted payload first; legacy plaintext only when no encrypted row exists. Any malformed encrypted row fails closed and must never fall back to plaintext.
2. Backfill in bounded, resumable batches. Encrypt, decrypt and byte-compare canonical JSON before recording the row as verified. Cursor、limit、coverage digestを固定し、同じbatchの再開は冪等に扱う。
3. Measure coverage by account and stop on any mismatch. Never log payloads, ciphertext or patient identifiers.
4. Deploy encrypted-write-first code and require the encrypted insert to succeed in the same D1 batch as the response insert.
5. After 100% verified coverage、verified backup、key recovery acknowledgement、write freeze、別principalのapproval/executionを再確認した場合だけ、legacy `answers_json` and `patient_snapshot_json` with valid empty JSON sentinelsへCAS更新する。Do not drop columns in an additive migration.
6. Remove plaintext fallback only after the sentinel scrub is verified.

Rollback after step 5 requires an explicit restore that decrypts verified envelopes back into the legacy columns before an old Worker is deployed. A silent fallback is forbidden.

## Read, write and authorization contract

Encryption is not authorization. Every lookup remains constrained by `line_account_id`, owner friend and patient relationship before ciphertext is returned or decrypted. Decryption happens only after staff/account or LINE-owner authorization. Admin list queries continue to return summaries and decrypt only the selected response.

Writes use optimistic revision checks. A key or decrypt failure returns a generic 5xx response, records only a PHI-free error code, and does not partially save plaintext. Automated LINE notifications never include answers or other PHI.

## Rotation and operations

- `key_version` selects the configured key; only the active version encrypts new records.
- Rotation is read-old/write-new, followed by bounded re-encryption with CAS on response/envelope revision.
- Key removal is blocked until no row references that version and a restore drill has passed.
- Metrics contain counts by tenant/account and error code only. No payload, nonce or patient identifier enters logs.
- Required tests: round trip, AAD swap rejection, wrong-tenant rejection, tamper rejection, duplicate nonce guard, concurrent revision conflict, backfill resume, scrub rollback and no-plaintext-log assertions.
- 現行key versionは`1`だけである。rotation/rewrap経路を実装・実証するまでは、APIのFLE readinessを`UNVERIFIED`から上げない。

## Release gate

Local code and tests are not production proof. Production enablement requires secret provisioning, exact
deploy source、verified backup generation、coverage 100%、approved key recovery、restore drill、
security review、別principalのnamed approval/execution、全batchのread-back evidenceが必要。
plaintext scrubはrollback readを含む別Human Gateであり、backfill成功から推論しない。
