# Pharmacy Harness Line Implementation Plan

Status: logical multi-tenancy is under local implementation on
`v0.26.0/feature/logical-multitenancy`. Worker, DB, LIFF, and Admin focused
tests/builds pass locally, including the additive `custom_022` integrity
triggers. The currently public dev LIFF/Admin Pages still serve an older bundle
(the multitenant asset contract is not present). No deployment was run in this
task. Production data and settings were not read or mutated.

The former per-customer repository and per-customer Cloudflare delivery model
is retired. Its GitHub update workflows, customer onboarding scripts, tenant
self-update API, and tenant update UI are not part of this product topology.

## Current architecture

```text
dev -> main -> central CI/CD -> one Cloudflare application
                                      |
                                      +-- tenant-scoped staff sessions
                                      +-- tenant-scoped LINE accounts
                                      +-- tenant-scoped D1 records
                                      +-- tenant/account-scoped R2 keys
```

The base OSS installer and update-engine packages may remain for upstream tool
compatibility, but pharmacy tenants cannot invoke them through the Worker or
admin dashboard.

## Required invariants

- Every authenticated admin request has one server-verified tenant context.
- Request query/body account IDs are selectors, never authorization evidence.
- Every tenant-owned query is constrained by the authenticated tenant or by a
  resource relationship that resolves to it.
- LINE webhook and LIFF identities resolve an active tenant/account mapping.
- R2 patient objects use tenant/account prefixes and private authenticated reads.
- Cron jobs operate only on active tenant-mapped accounts; pharmacy mode keeps
  generic CRM jobs fail-closed.
- Applied migrations are never edited. New schema changes use additive
  `custom_NNN` migrations.
- Automated pharmacy notifications remain PHI-free.

## Central deployment contract

- Only the platform release workflow deploys Worker/Admin/LIFF.
- Tenant administrators cannot call infrastructure update endpoints.
- D1/R2/Secrets bindings are verified before and after deployment.
- Migration approval, backup/bookmark evidence, smoke tests, and rollback remain
  platform human gates.
- Deploying code must not recreate, overwrite, or detach tenant mappings,
  staff memberships, LINE configuration, D1 records, or R2 objects.

## Current local evidence

- `custom_014_pharmacy_logical_tenants.sql` introduces tenant, account mapping,
  and staff membership tables with conservative backfill.
- Admin login binds a pharmacy code to an authorized tenant membership.
- LINE account APIs, LIFF resolution, webhook account resolution, prescription
  images, incoming images, token refresh, and selected cron paths have tenant
  boundary tests. `custom_020` backfills explicit staff-to-account assignments;
  `custom_021` makes LINE webhook redelivery receipts tenant/account scoped.
- Generic customer repository update automation and tenant self-update controls
  are removed locally.
- An earlier permitted dev smoke check recorded healthy Worker/CORS responses
  and HTTP 200 for the Admin and LIFF Pages. The current public dev LIFF asset
  audit, however, found an older bundle without the multitenant pharmacy build
  marker; dedicated Pages topology and current Admin/LIFF asset deployment are
  therefore not currently verified.
- The additive `custom_014` through `custom_022` migrations and generated
  bootstrap pass local schema, replay-ledger, and checksum checks. A raw replay
  of `custom_016` against an already-generated bootstrap is not a supported
  deployment operation because it contains `ALTER TABLE`; the migration ledger
  prevents that reapplication in a live upgrade. No D1 mutation was performed
  in this task, so live development or production application state remains a
  separate human gate.

See `docs/pharmacy/MULTITENANT_OWNERSHIP_MATRIX.md` for the explicit
ownership/deny matrix and residuals. This is still partial deployment evidence:
local tests do not prove live Pages freshness, D1 migration state, R2/Secrets
preservation, or LINE rich-menu publication.

## v0.35 pharmacist review concurrency contract (2026-09-05)

- Existing submission source `POST` and validity `PUT` accept an additive
  `expectedUpdatedAt` field: an ISO timestamp matches that review row, and
  explicit `null` requires the row to be absent. Omission retains the previous
  client contract; it does not prove stale-write protection for old clients.
- The new Admin sends the version from the start of editing, not a background
  refresh. A conflicting save returns HTTP 409 with the existing
  `{ success: false, error }` envelope, changes neither review nor audit, and
  never automatically replays a mutation. Same-millisecond saves must still
  advance the stored version.
- Admin preserves the draft, displays the conflict, and requires an explicit
  reload/discard before taking the new version as an editing base. Source and
  validity are separate review records. Account/staff authorization, immutable
  clinical status history, and PHI-free audit remain mandatory.
- Rollout is Worker first, then Admin; old Admin continues to function with the
  new Worker. An old Worker ignores the added field and cannot establish the
  new concurrency guarantee. This guarantee requires current Worker evidence;
  mixed-version compatibility is not a release-readiness claim.

The existing prescription detail response also adds optional `intake` metadata
(linked/latest revision and submission time, review time), scoped to the
submission/account/owner/patient tuple. No answers or encrypted payloads are
projected. Missing fields from an old Worker mean unverified, not no intake.
The historical `patient_display_name` field remains the LINE friend's display
name; Admin explicitly labels it as such rather than treating it as identity.

Fulfillment quote POST additionally accepts optional `expectedRevision` (a safe
non-negative integer; zero requires no existing quote). Omission preserves old
clients. The append checks the latest account/submission revision and allowed
submission state atomically; conflicts retain the existing HTTP 409 `{ error }`
contract. A quote and its linked Myna event commit together or neither commits.
Admin retains the editing revision across refresh, preserves failed drafts, and
requires explicit discard/reload before retry. This guarantee likewise requires
the new Worker; it cannot be claimed while an old Worker serves the request.

The quote/event rollback relies on the native D1 `batch()` transaction contract:
[Cloudflare D1 database methods](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Local SQLite tests execute the shipped quote/event schema and actual statements;
they are not deployed D1 or LINE evidence. Staff quote inputs and displayed
prescription timestamps use Asia/Tokyo regardless of the device time zone.

## 2026-09-13 追加要件：薬局共通ログインと7日工程の継続

以下は2026-09-13のユーザー指示を記録した現行要件であり、実装完了の証跡ではない。

- 薬局テナントのログインを薬局共通アカウント1つにし、入力は薬局コードと
  パスワードの2項目にする。個人IDの入力やブラウザによる隠しIDの補完は不要とする。
- この認証変更について旧ログインの後方互換性は要求しない。旧個人ログイン・
  旧セッションの扱いを明示し、混在版の互換経路を目的に実装を増やさない。
  他の薬局業務API全体の互換性廃止を意味しない。
- 操作ログは必須。共通主体、薬局・対象account、操作、日時、結果を判別でき、
  実際には識別できないスタッフ個人を操作者と偽って記録しない。
  パスワード・生のセッショントークン・PHIをログへ追加しない。
- 移行には必要なマイグレーションを用意する。既存業務データや過去ログの削除、
  本番DBのリセット、既存個人のパスワードの無断流用は承認されていない。
- 薬局スタッフが日常業務へ迷わず進めるログイン案内・画面配置も対象とする。
- ログインだけに範囲を縮小せず、V035-0/2/3/4/5/6を含む7日工程を継続する。
  参加資格、運用担当・営業時間・SLA、実スタッフ試験は未確定・未実施を
  実装や合成テストの成功で置き換えない。
- 初回betaは本人利用に加え、正式な代理権がある家族の利用も含める
  （2026-09-13ユーザー確定）。有効な代理権だけでbeta参加資格を代替しない。
- 営業時間・一次返信の期限・主担当・代行担当はすべて未定
  （同日ユーザー回答）。値を推測して自動送信や運用開始に用いない。
- 作業ブランチは`dev`。既存差分を保持し、ローカル実装・検証を行う。
  commit/push/deploy、実資格情報の配布、本番操作、beta activationは行わない。
- 今回のOracle計画・独立レビューはユーザーが`Latest / Pro`を許可した。
  GPT-6 Proの実行が確認できたとは記録しない。現在の送信許可は
  `/tmp/pharmacy-shared-login-oracle-brief-20260913.md`の1ファイルだけであり、
  新しいソース・差分パケットへの送信許可を含まない。

### 2026-09-13 継続実装の検証記録（ローカルのみ）

2026-09-14追記：ユーザーは共通アカウントを`admin`相当（owner専用の機能切替・
スタッフ管理は除外）、初期発行・忘失時復旧を全体管理者担当とする方針を承認した。
Oracleへの送信は`/tmp/pharmacy-implementation-oracle-allowlist-20260913.md`の
36ファイルについて、非機密内容と本依頼の変更差分を承認済み。以下の前日時点の
承認待ち記録は履歴であり、この承認で解消した。未列挙ファイルは自動追加しない。

- 処方せん状態更新の同時実行と、同一時刻での期限切れ確認の再試行で、
  更新0件にもかかわらず成功イベントが追加される2件をSQLite実行テストで再現した。
  直前の更新件数が1件の場合だけ成功イベントを追加する条件を入れ、両テストをGreenにした。
  growth-loopは共通の`runAuditedMutation`で条件を適用する。
- 関連5ファイル112テスト、Worker全体244ファイル2,622テスト、
  `pnpm --filter worker exec tsc --noEmit --incremental false`、`git diff --check`が成功。
- 追加のMiniflare 5によるローカルD1確認は、最初の起動オプション不適合を修正したが、
  再実行の検証プロセスが完了せず中断した。D1ランタイム実証の成功とは扱わない。
  本番D1には接続していない。
- 2026-09-14追記：stdinの`--input-type=module`起動ではD1 binding取得前に停止したが、
  ファイル起動ではMiniflare 5のbinding取得と`SELECT 1`が成功した。
  `pnpm exec tsx /tmp/pharmacy-d1-runtime-probe-20260914.mjs`で実際のrepository関数を
  ローカルD1へ接続し、期限切れ再試行・同時状態更新の成功イベントが各1件であることを確認。
  最小合成テーブルによるSQL/batchの検証であり、全マイグレーションや本番D1の検証ではない。
- Oracle改訂計画`pharmacy-shared-login-revised-plan`は`Latest / Pro`の選択確認、
  回答保存、会話アーカイブが完了。旧ログイン維持案は採用しない。
  新しい非人間の共通主体から既存資格情報・セッション・監査を再利用する案であり、
  独立した計画レビュー・実装レビューは未実施。共通権限・発行復旧の担当と、
  正確なソース送信一覧の承認が必要。
- この記録は共通ログイン、参加者制御、7日工程、運用開始やリリースの完了を示さない。

### 2026-09-14 独立計画レビューと残る確認

- `pharmacy-shared-login-plan-review`は別会話で完了し、判定は`BLOCKED`。
  `Latest / Pro`のUI選択確認、回答のローカル保存、アーカイブを確認した。
  共通権限・復旧担当の承認待ちは解消済みであり、再承認事項ではない。
- 計画へ追加する事項は、旧Cookie/Bearer/CLI・個人資格情報発行経路の閉鎖、
  PW変更時の現端末を含む失効、操作主体・対象・結果の監査、共有主体のDB制約、
  UIの旧owner表示キャッシュ、人間の担当者と共通ログイン主体の区別。
- Oracle案のcredentials表再作成は、そのまま採用しない。
  `scripts/check-migrations.ts`はDROP TABLEとRENAME TABLEを禁止する。
  旧ログイン互換性の不要という承認を、データ・スキーマ破壊の許可に拡張しない。
  非破壊の代案を比較し、計画を改訂して再確認する。
- 主担当の原文確認で、medication-followupのtransition routeが認証staff IDをactorIdへ渡し、
  repositoryがassigned遷移で同じIDをassigned_toへ保存すると確認した。
  共通主体を人間担当者として自動代入しない変更が必要。担当者の未定値は補完しない。
- schema.sqlだけでは現行DBを表さず、後続migrationとbootstrap生成経路も確認対象。
  承認済み36ファイル以外の必要な依存資料は追加送信前に正確な一覧の許可を得る。
- 監査重複修正の独立実装レビュー`pharmacy-success-audit-implementa-review`は実行中。
  ローカルテストの成功をレビュー完了、共通ログイン実装完了、リリース可能と扱わない。

### 2026-09-14 追加承認後の実測・修正

- ユーザーの`ok`で、`/tmp/pharmacy-oracle-additional-allowlist-20260914.md`の
  追加21ファイルの非機密内容・本依頼の差分送信が承認された。
  全21ファイルのgitleaks検査は検出なし。既存36ファイルと合わせた範囲から
  認証計画改訂に必要な33ファイルを選び、`Latest / Pro`、通常Chat、
  保存後archiveの設定をdry-runで確認して`pharmacy-additive-shared-auth-plan`へ送信した。
- `pharmacy-success-audit-implementa-review`は限定した2箇所＋2テストのコードレビューPASS。
  D1のトリガー副作用を含むmetadata検証は未完了との指摘があり、主担当が追加実測した。
- ローカルD1（Miniflare 5.20260831.0-alpha）で既存capability revision/mirror triggerを
  実行すると、batch metadataは`[3,1]`となり、保存・監査成功後に既存の
  `mutation.meta.changes === 1`判定が失敗を返した。これは実測で確認した既存不具合。
  共通`runAuditedMutation`のSQL側`changes() = 1`を保持し、それを通って作成された
  監査1件を成功判定に使用する最小修正を行った。一律`>= 1`への緩和はしていない。
- 既存テストへmetadata 3件のケースを追加してRed→Greenを確認。
  Worker全244ファイル2,623テスト、Worker tscが成功。
  ローカルD1では期限切れ再試行・同時状態変更の成功ログ各1件、capabilityの
  revision増加・mirror更新・監査1件、同じ古いCAS batchの`[0,0]`、監査INSERT例外時の
  設定/revision/mirror/イベント全体のrollbackを確認した。
  コマンドは`pnpm exec tsx /tmp/pharmacy-d1-runtime-probe-20260914.mjs`。
  合成データで対象SQLと既存triggerだけを検証し、本番・全migrationは検証していない。
- metadata判定の追加修正は独立再レビュー待ち。共通ログイン計画の改訂・別会話レビュー、
  共通ログインと参加者制御の実装・検証、残る7日工程と人間の運用ゲートは未完了。
- 追記：別会話`pharmacy-d1-metadata-review`は戻り値変更の限定レビューPASS。
  環境・実測スクリプト・実行出力はOracle未添付のため、D1実測は主担当の実行証拠であり
  Oracleが独立再現したとは扱わない。コード修正必須の指摘はない。
  既存schemaにない監査RAISE(IGNORE)時のrollback限界は既存の条件付き弱点として残す。
  再レビュー依頼文の「本番に存在しない」は確認範囲を越えた表現だったため採用しない。
  確認できたのは添付canonical schemaに当該triggerがないことだけで、本番schemaは未検証。

### 2026-09-14 非破壊の共通認証・改訂案（独立計画レビュー待ち）

Oracle計画`pharmacy-additive-shared-auth-plan`の回答保存・`Latest / Pro`選択・archiveを確認。
以下はローカル実装用の改訂案であり、まだ切替・リリースの承認ではない。

1. 既存credentials表を残し、共通credentialのlogin_idには実際のtenant_codeを格納するA案。
   入力・検索は薬局コードとPWだけ。個人IDの隠し補完やownerの先頭行選択はしない。
   旧login_idとtenant_codeのNOCASE衝突を事前検査し、衝突時は無変更で停止する。
   B案（共通credential表1つの追加）は衝突が確認された場合の別改訂候補であり、
   A/Bのtenant別混在や自動fallbackは実装しない。実データの衝突0件は未検証。
2. 新規migrationは`014_custom_071_shared_pharmacy_auth.sql`、対応する合成DBテストは
   `custom_071_shared_pharmacy_auth.test.ts`を予定。既存schema.sql/001/適用済みmigrationを
   書き換えず、bootstrapは正規generatorから再生成する。
3. staffへprincipal_kind（human/pharmacy_shared）とshared_tenant_idを追加。
   sharedはstaffとmembershipの両roleがadmin、tenantごとに停止中を含め最大1つ。
   身元・tenant・主キーの変更、削除/REPLACE、owner昇格、platform admin登録を拒否。
   同tenantのaccountアクセスだけを追加し、人間のmembership/割当/業務列は保持する。
4. credentialsへauth_enabledをdefault 0で追加し、旧人間credentialは認証無効のまま保持。
   共通主体はcredential未発行で作成する。固定PW・人間PWコピーは不要。
   初回INSERT以外はversion付きUPDATE。共通kind/tenant/admin/active/auth可否/version/
   session種別のDB guardを追加し、旧sessionの失効更新だけは許可する。
   version変更・無効化で全sessionを失効。旧staff keyは平文とhashの両方を退役させ、
   再発行を拒否する。他用途へのキー共有がある場合は影響範囲の確認なしに変更しない。
5. tenant作成の人間プロフィールと資格情報発行を分離し、platform bootstrapの入力を保全。
   旧staff create/reset、tenant admin-bootstrap、owner代行CLI発行/旧key-only revokeを閉鎖。
   receiptはcredentialなしでも読めるようにし、過去staff IDを現在の共通主体解決に使わない。
   platform本人の限定pas Bearer bridgeは拡張せず維持する。
6. platform専用Cookie/CSRF/通常session内に
   `POST /api/platform-admin/tenants/:id/shared-login/issue`と`.../reset-password`を設ける。
   書込み時にもplatform sessionを再検査し、サーバーでtarget共通主体を解決する。
   freshな仮PWは成功時だけ返し、再試行・競合で未保存PWを発行済みとして返さない。
   tenantや主体の停止状態を復旧操作で自動解除しない。
7. 通常PW変更はcurrentPW・version・現sessionを検査し、全session失効と必須監査を原子的に行う。
   新sessionは発行せず3Cookieを削除し、reauthenticationRequiredで明示再ログインへ戻す。
   成功監査はSQL内で直接更新1件を必須にし、0件ならSQLエラーでbatchをrollbackする。
   D1のmeta.changesはtrigger分を含むため、mutation metadataの単純な1件判定に依存しない。
8. 匿名を偽staffとして記録しないためpharmacy_auth_audit_eventsを追加し、actor_kind/
   nullable actor_staff_id/target/action/outcome/request ID/固定reasonを記録する。
   PW/hash/token/body/PHIは保存しない。ログインのsession/監査/throttle、失敗試行の
   throttle/監査を同一batchへ置く。DB不能時は503＋限定した構造化ログであり永続監査成功を装わない。
   既存業務監査のactor_kind/outcomeはnullable追加、過去行は埋め替えない。
9. follow-upのactorIdは共通主体、assigned遷移のassigneeStaffIdは明示した人間担当者。
   human/active/同tenant・account割当を検査し、未指定は拒否、未担当の作成はNULLを保持する。
   eventにも担当者を記録し、同じ冪等キーで別担当者を指定した再試行は409。
   owner専用staff一覧を開放せず限定候補一覧を用いる。選択を本人認証・署名とみなさない。
10. WebはloginId入力/送信を削除し、PW変更/401/logoutで旧identity・account・CSRFを破棄。
    遅い旧応答の復活を防ぎ、session未確認時にowner導線を表示しない。
    復旧案内は全体管理者へ統一し、未定の営業時間/SLA/連絡先を補完しない。

必須検証：コード衝突時の無変更、旧人間/業務/監査/CLI履歴保持、FK、旧全認証経路拒否、
shared二重作成/REPLACE/越境/昇格拒否、platformと患者認証の保全、issue/reset競合、
全端末失効、監査障害rollback、旧owner cache、担当者資格/再試行、upgradeとbootstrapの一致。
本番の事前検査・資格情報配布・実スタッフ試験はローカル合成テストで代替しない。
緊急避妊薬のroute→資格照合→対面確認/販売記録は別途限定確認が必要。
主担当は共通staffを薬剤師へ自動登録し得る経路と、認証IDを販売記録へ代入する経路を確認した。
共通主体の薬剤師登録・署名を禁止するだけで既存案件を放置してよいとはしない。
この改訂はV035-0/2/3/4/5/6とbeta参加者制御の工程を削除・置換しない。

### 2026-09-14 独立計画レビュー結果

Oracle別会話 `pharmacy-shared-auth-plan-final` の回答全文を主担当が確認。
共通認証A案・非破壊migration・follow-up担当者分離は計画PASSであり、
ローカル実装・受入試験・本番切替の完了を意味しない。

追加の受入条件として、認証監査の限定閲覧経路、429/Origin拒否の記録責任、
監査INSERTが0件となる場合の成功禁止、旧成功応答だけでなく旧401・複数タブの
identity保全、generator前後の既存schema/001/適用済migrationのハッシュ不変を採用する。
SQL changes()は対象UPDATE直後に評価する。担当候補のhumanに個人認証有効化は要求しない。

限定BLOCKEDは緊急避妊薬の機微閲覧・対面確認・販売記録の認可契約。
共通PWと薬剤師の選択では操作者本人の薬剤師資格は証明できないため、
従来の本人資格照合を単に選択IDへ置き換える権限変更は行わない。
共通アカウントへ許す閲覧・入力範囲のユーザー判断を待つ。
人間の資格者・担当者・販売薬剤師IDと共通の記録actorは分離し、過去の記録を保持する。
既存案件を一律拒否・自動取消せず継続処理できる経路を受入条件とする。
権限が確定した後も、書込み時の資格再検査、別human/outcome再送409、
在庫trigger込みのローカルD1成功応答・一回だけの減算は別途検証する。
この限定保留は認証・migrationの合成ローカル実装を禁止するものではない。

### 2026-09-14 共通ログイン実装と移行限定レビューの結果

共通ログインのローカル実装を`dev`で完了した。薬局画面は薬局コード＋パスワードだけを送信し、
共通主体`pharmacy_shared`の有効な`admin` membershipだけがopaque sessionを発行する。
初回発行・忘失時の再発行はplatform adminの専用経路に分離し、旧個人ログイン、tenant admin-bootstrap、
tenant-owner CLI sessionの発行経路は`410`で閉鎖した。認証成功・失敗・パスワード変更・platform発行/再発行は
PHI・パスワード・tokenを含まない`pharmacy_auth_audit_events`へ記録し、Webの旧identity/account/CSRF cacheも
再認証時に破棄する。実資格情報の配布、production DB変更、deploy、beta activationは行っていない。

ユーザーが明示承認した次の2ファイルだけをOracle実装レビューへ送信した。
`packages/db/migrations/014_custom_071_shared_pharmacy_auth.sql`、
`packages/db/test/custom_071_shared_pharmacy_auth.test.ts`。レビューは移行限定で、結論は「要修正・追加検証」だった。
指摘された監査IDの`NOT NULL`/`WITHOUT ROWID`/ID再利用防止、監査FKの`RESTRICT`、shared主体・membership・credential・
account assignment・sessionの`INSERT OR REPLACE`/再割当/再利用防止、無効化後の安全なcredential停止、
および監査列テストの弱い否定アサーションを修正した。Oracleの全実装（Worker/API/Web）レビューやproduction reviewの
PASSとは扱わない。移行レビューのarchive保存は失敗したが、transcriptはローカル証跡として確認済みである。

修正後のローカル検証は、DB 88 files / 415 tests、Worker 244 files / 2,623 tests、Web 52 files / 241 tests、
scripts 21 files / 218 tests、workspace typecheck、migration checker、bootstrap generator check、`git diff --check`、
新設2ファイルのgitleaksがPASS。Worker/LIFF/共有パッケージのbuildと、`NEXT_PUBLIC_API_URL`をプレースホルダー指定した
Web buildもPASSした（未設定の通常Web buildは同環境変数エラーで停止）。これは合成・ローカル検証であり、既存production
schemaへの適用成功を示さない。

この時点で未完了だった境界は、V035-5のbeta参加者membership（本人＋正式な代理権がある家族を含む）のserver-side実装、
緊急避妊薬の機微閲覧・対面確認・販売記録の認可契約、営業時間・一次返信期限・主担当・代行担当の確定、
実スタッフ/実端末試験、production migration/release gateである。これらをlocal greenや共通ログイン実装で置き換えない。

### 2026-09-14 V035-5 書込み認可境界の補修（membership実装前の記録）

ユーザーの追加承認後、Oracleの`pharmacy-v035-5-authority-gap`計画レビューへ、非機密の認可設計要約だけを送信した。結論は「既存患者認可の共有write境界補修として条件付き採用」で、beta membershipの新設や成人家族の正式代理権モデルは先送りした。

既存の`patientAuthorityPredicate`を再利用し、リンク済み処方の下書き作成・画像予約/確定・送信・取消・再提出・到着報告・復旧参照を、`line_account_id`、owner、対象patient、アーカイブ状態、binding suspension、未成年proxyの失効/取消状態に相関させた。未リンクの既存処理は維持した。服薬フォローの患者回答は、初回取得、idempotency replay、event INSERT、CAS UPDATEの各段階で同じ現行認可を再確認する。通知senderの既存停止判定は変更していない。

`packages/db` 88 files / 419 tests、`apps/worker` 244 files / 2,624 tests、workspace typecheckがPASS。migrationは追加していないため、既存の`custom_005`/`custom_004`/`custom_012`/`custom_068`/`custom_070`を使う実DB合成テストで確認した。今回の承認済み送信allowlistにWorkerコード差分は含めず、Oracleへコード差分を送信していない。

追加のRed -> Greenでは、代理権失効後に残っていた処方履歴、服薬フォロー一覧/対象取得、継続フォロー・次回事前送信一覧/回答、Myna active/report、患者timelineの読み取り・状態変更漏れを再現した。既存`patientAuthorityPredicate`を各患者向け読み取りと書込みtransactionへ相関し、未リンクの処理とstaff account readは維持した。Myna作成時の患者選択もbatch内で再検証する。全Worker/DBテスト、workspace typecheck、`git diff --check`が最新状態でPASSしている。

この時点ではV035-5のparticipant membership、本人＋正式な代理権がある家族の登録/人数上限/世代、成人家族の代理権、privacy/consent後の継続行列、営業時間・SLA・担当者、実端末・production migration/release/activationは未完了であった。

### 2026-09-14 V035-5 参加者membershipのlocal実装（activation未実施）

Oracleの計画レビューとAstraの読取り専用監査を踏まえ、既存の患者・proxy・tenant認可を再利用した最小実装を`dev`へ追加した。これはlocal合成データでの実装・検証であり、betaの有効化やproduction操作ではない。

- `015_custom_072_pharmacy_beta_memberships.sql`で薬局ごとの`beta_enabled`（既定`0`）と、薬局アカウント×participant×subject単位の`pharmacy_beta_memberships`を追加した。状態は`active`/`suspended`/`revoked`で保持し、期限切れはserver timeの`[starts_at, expires_at)`で派生判定する。自動登録・自動再開・自動更新は行わない。
- 薬局スタッフのowner/adminだけが同一tenantのlist/grant/suspend/resume/revoke APIを利用でき、`expectedVersion`、期限、状態遷移、監査をserver-sideで検証する。監査書込みを含むgrant/transitionは同一batchで原子的に処理する。
- LIFFの患者向けintake、処方せん、継続、服薬フォロー、Myna、timelineとfeature accessは、beta有効時に現行membershipを要求する。DBの患者predicateと書込みtransaction、通知送信直前の再確認を併用し、失効済みproxy・membership・古いsession/job/webhookからPHIや副作用を再開しない。privacy撤回・proxy取消・通知停止などのcontrol pathとstaff account read、未紐付け処理は維持する。
- 本人と、既存の正式な未成年proxyに紐づく家族を対象にした。成人家族は本人確認・正式代理権の証跡と運用担当が未定のため、既存どおり登録を閉じている。これはbetaを無断で広げないための停止点であり、正式手順確定後に別途追加する。
- `packages/db/test/custom_072_pharmacy_beta_memberships.test.ts`、Workerのroute/sender/各domain回帰テストで、cross-account、期限境界、停止/再開/取消、旧処理の再実行、監査失敗時rollback、未参加者遮断を確認した。最終local検証はDB 89 files / 423 tests、Worker 245 files / 2,629 tests、workspace typecheck、migration checker、`git diff --check`を対象とする。実スタッフ/実端末、production migration/release/activationは未実施である。

### 2026-09-14 V035-1 読み取り専用アクションキューのlocal実装

既存の処方せん、Myna、患者アンケート、継続、服薬後follow-up、緊急避妊薬、未対応チャットを再利用し、各ドメイン51件以内・全体50件以内のbounded unionを`GET /api/custom/pharmacy/action-queue`へ追加した。account scopeと部分失敗を維持し、レスポンスはdomain/status/deadline区分/既存画面linkだけで、record ID・患者/友だち情報・自由記述・復号結果・mutationを含めない。薬局homeへ読み取り専用一覧と「先頭50件」表示を追加した。

Worker/Webの追加テスト、API coverage、型検査、`git diff --check`はPASS。50件超のcursorとrecord単位deep linkは、現行の既存画面導線で不足が実測された場合の拡張とし、固定上限と部分表示を画面上で隠さない。beta activation、実スタッフ/実端末、production migration/release/deployは未実施である。

### 2026-09-14 V036 閉ループfollow-upのlocal実装（外部運用gate未実施）

既存の服薬後follow-up状態・event・idempotencyを使い、3本のadditive migrationで質問票版、一次返信期限、電話/LINE対応記録、運用設定、明示的な人間担当者を追加した。`concern`/`pharmacist_requested`/`escalated`からの不正な完了を状態遷移で拒否し、`responded`/`closed`は非`no_answer`の対応記録を要求する。対応記録は同じ薬局account、対象follow-up、スタッフ権限、CASへ束縛し、電話をLINE対応として保存しない。

自動通知は既存のapproved PHI-free template、通知ledger、stable retry keyを再利用し、送信直前にaccount/tenant/friend/following/capability/患者認可/対象状態/運用設定/outbound pauseを再確認する。営業時間・一次返信期限・主担当・代行担当はユーザー回答どおり未定のため、運用設定を有効化せず、follow-up通知はfail-closedで停止する。旧schemaの既存読み取り・既存状態遷移は維持し、追加列・対応記録を必要とする経路は503で停止する互換テストを追加した。

Worker/Webの服薬後follow-up、通知、route、旧schema互換テストと型検査はlocal PASS。実LINEの到達/既読、実スタッフ・実端末、Meet登録/reminder、外部SMS/email、運用値確定、production migration/release/activationは未実施である。

### 2026-09-14 追加監査と最終local検証

Astraの読取り専用監査で見つかった旧schemaの患者認可、対応記録なしの完了、旧payloadの担当者扱い、無効staff、送信直前membership/運用担当再確認、互換test adapterを修正した。修正後はDB `90 files / 428 tests`、Worker `247 files / 2,645 tests`、Web `52 files / 242 tests`、LIFF `24 files / 148 tests`、scripts `21 files / 218 tests`、workspace typecheck、全workspace build、migration checker `17 migrations`、bootstrap生成、`git diff --check`がPASSした。いずれもlocal/synthetic evidenceであり、実LINE・実スタッフ/実端末・運用値確定・production migration/release/activationの完了を示さない。

実装後Oracleレビュー`pharmacy-local-implementa-review`は、ユーザー承認済みのmigration/testの2ファイルだけを送信したが、別セッションによるOracle profile lockで`ERROR`となったため、レビュー結果は`NOT_RUN`として扱う。添付外のコードを追加送信していない。

### 2026-09-14 残存事項の追加監査・補修

上記の実装後監査に続き、Astraを旧schema互換、認可・競合、通知・beta、Web・性能の4観点で分離して再確認した。実装可能な確定不具合だけを主担当が修正し、契約・運用未確定の項目は権限を推測せず保留した。

- `019_custom_076_pharmacy_followup_operations_scope.sql`を追加し、follow-up運用の主担当・代行担当について、insert/update時のtenant membershipとaccount assignment一致、`enabled=1`時のactive human staffをSQLite triggerで強制した。無効状態の事前設定とnullable backupは維持し、既存行の削除やbackfillは行っていない。
- `packages/db/test/custom_076_pharmacy_followup_operations_scope.test.ts`、update-engineのmigration manifest、bootstrap SQL/meta、既存migration期待値を更新した。cross-tenant insert/update、無効staffの事前設定、enable時のactive human要件を合成SQLiteで検証した。
- 開発audit経路の既知脆弱性は、`undici@7.29.0`と`sharp@0.35.4`への狭いpnpm overrideで解消した。全依存・production依存の`pnpm audit`はともに0件で、無関係な依存一括更新は行っていない。
- `computeDedupBroadcastPreview`の全呼出元をdynamic importへ揃え、Worker buildの`INEFFECTIVE_DYNAMIC_IMPORT`を除去した。HLS `574.61 kB`は既に遅延ロードされているため、性能実測なしの分割は行っていない。
- 追加した`019`／`020` migration／testのgitleaks個別走査は検出0件だった。Worker／DB全体の走査では既存synthetic test fixtureの固定値19件がgeneric-api-keyとして誤検出されたが、実credentialではないことを確認した。
- 4観点のレビューで再確認したmembership世代束縛は、既存retry keyを変えずに作成時の`membership_id`を保持する追加migration `020_custom_077_pharmacy_beta_notification_bindings.sql`として実装した。処方せん状態、患者リンク後のstatus event、服薬後follow-up、継続期待、処方せん期限通知をsource triggerで同じaccount・participant・subjectへ不変束縛し、beta有効時にbindingなしの旧queueを送信しない。停止／再開は同一IDのretryable、取消→再付与は旧queueを新IDへ再束縛しない。成人家族の正式代理権は、本人確認・証跡・許可操作・期限／取消の運用が未確定のため、既存の拒否を維持する。
- 追加実装レビューで確定した5件を補修した。患者リンクtriggerをsubmissionとevent作成時刻へ相関し、期限通知triggerのbeta条件を追加、停止中の初回status通知をmembership再開後に再発見するretry queryを追加した。外部送信前の一時停止・運用未設定・suspendedでは`attempted`を`failed`へ変換せず、binding読取障害は恒久blockedへ変換しない。対応する合成境界テストを追加した。

今回の追加検証は、`pnpm verify:ci`（全workspace typecheck、全テスト4,058件、scripts、19 post-baseline migrations）、`NEXT_PUBLIC_API_URL=https://worker.example.invalid pnpm build`、LIFF Chromium E2E `13 tests`、Web Chromium E2E `11 tests`、frozen lockfile install、targeted DB/Worker test、`pnpm audit`全依存／production依存、`git diff --check`でPASSした。全てlocal/synthetic evidenceであり、実LINE、実スタッフ・実端末、運用値確定、production migration/release/activationを示さない。

## v0.35 beta admission preparation (HISTORICAL RECORD, 2026-09-06)

The existing LINE identity, consent, proxy permission and account capability
checks do not establish invitation membership. The initial one-pharmacy,
five-person cohort is still a proposal, not an activated restriction. The user
confirmed on 2026-09-13 that authorized family patients are included alongside
self-use. The membership key, operation matrix and migration still require
implementation; this decision alone does not activate membership.

The following operation boundaries are preparation for V035-5, not current
runtime guarantees or authorization to activate a beta account:

- Public pharmacy information, privacy explanations, withdrawal/contact-stop,
  proxy revocation and data-subject rights remain available through their
  existing identity/authorization checks; no blanket beta middleware may hide
  these routes.
- New patient work, expanding an existing case, resubmission and follow-up
  answers require a current membership decision in addition to the existing
  account/patient/consent/proxy checks. Existing-record reads and staff terminal
  drain need an explicit operation matrix so that withdrawal does not orphan
  an ongoing clinical case. Whether a particular continuation is permitted is
  decided with the pharmacy owner, not inferred from a valid LINE token.
- Public LINE chat can still arrive from non-participants. Receiving a message
  must not enroll the sender in beta clinical work. Its existing retention,
  ordinary-consultation response and responsible staff remain separate.
- Membership must be checked in the write transaction, not only before an
  awaited operation. An upload that stages bytes before revocation needs its
  existing safe staging/reconciliation path; no production delete is implied.
- Queued work must retain the membership generation under which it was
  authorized, and recheck current membership before dispatch. Regranting must
  not resurrect an older queued notification. A provider call already in
  flight cannot be promised cancellable; the stop boundary and unknown-outcome
  reconciliation must be explicit before activation.
- Preserve existing route/field meanings and omitted-field behavior. An old
  Worker does not know a new admission rule: an activated beta cannot safely
  roll back merely by switching that rule off. Prove a compatible hard-stop
  path covering old create/resubmit/jobs, or retain the new Worker and forward
  fix. Missing admission schema must not silently reopen an enabled beta.

The local readiness evidence lists the current tests and the uncompleted
human/operations gates. No invitation, membership write, migration, LINE
mutation, deployment or production operation has been performed for V035.
