# V032 pharmacy / patient LIFF / Platform admin route・page・role inventory

## 目的とスナップショット

V032-0 の実装対象は、新しい画面や API を追加することではなく、現行の薬局管理画面・患者 LIFF・Platform admin 画面と、それらが利用する API の実フローを一つの機械検査可能な inventory に固定することです。

- 基準 snapshot: `eaf35aa8aa8bb6cd831c84d30d2067662b48d3b7`
- 機械可読 SSOT: [`scripts/deploy/v032-route-inventory.ts`](../../scripts/deploy/v032-route-inventory.ts)
- 回帰テスト: [`scripts/deploy/v032-route-inventory.test.ts`](../../scripts/deploy/v032-route-inventory.test.ts)
- 現行検出値: 38 pages、42 API source groups、231 unique `METHOD path-pattern`
- この inventory はローカル source の静的検査だけを行い、Production、LINE、Google Calendar、実データを変更しない

このsnapshotは実装開始時点のlive baselineであり、現行worktreeの
route/page/test実在性とmount順は回帰テスト実行時に再確認します。

## 判定ルール

各 entry は次の情報を持ちます。

| フィールド | 判定方法 |
| --- | --- |
| `roles` | 未認証、tenant staff/admin、pharmacist、privacy staff、Platform admin、support grant 中の Platform admin を区別する |
| `authority` | 認証・スタッフ権限・tenant/account ownership の実際の境界を記録する |
| `lineAccountIdAuthority` | `line_account_id`/`accountId` が server-derived、server-validated selector、path scope のどれかを記録する |
| `queryAuthority` | query parameter は常に selector。server の tenant/account authorization を通過しない値は authority にならない |
| `displayedInfo` | 画面または API が返す代表的な情報を記録する |
| `mutation` | read-only、workflow、configuration、外部副作用などの変更を分類する |
| `confirmation` | CSRF、CAS/expected revision、human gate、UI confirmation、manual header、未検証境界を記録する |
| `phiClassification` | `PHI`、`PHI-with-support-grant`、`PHI-free-default`、`credentials`、`operational-sensitive`、`none` を区別する |
| `audit` | server audit、actor/revision、redaction、未確認の監査境界を記録する |
| `reachability` | `reachable`、`deferred`、source はあるが現行 index に未mount の `source-only-unmounted` を区別する |

## Page inventory

### Pharmacy admin

| path | source / component | role・authority | 表示情報 | mutation・confirmation | PHI / audit / test |
| --- | --- | --- | --- | --- | --- |
| `/login` | `apps/web/src/app/login/page.tsx` | unauthenticated → tenant-admin。`pharmacyCode` は入力であり authority ではない | session、password-change、safe redirect | login/logout/password change。credential、CSRF、server session | none / auth log / `provisioning/login-ui.test.ts`, `growth-loop/tenant-admin-ux.test.ts` |
| `/` | `apps/web/src/app/page.tsx` → Growth dashboard | staff session、server capability/account scope | today operations、readiness、active work | read-only。子画面の mutation は各画面で確認 | operational-sensitive / server-scoped read / `growth-loop/pharmacy-mode-ui.test.ts` |
| `/prescriptions` | `prescriptions/page.tsx` → `PrescriptionQueuePage` | staff、server `prescriptionLineAccountId` scope | queue、submission、patient/file detail | workflow、quote。CSRF、confirmation、expected-version | PHI / prescription event / `PrescriptionQueuePage.test.tsx`, `api.test.ts`, `v032-a2-contract.test.ts` |
| `/prescriptions/print` | `prescriptions/print/page.tsx` → `PrescriptionPrintPage` | staff、submission/account scope | print preparation/task | prepare/claim/ack。CSRF、state transition | PHI / print actor/status / `prescriptions/boundary.test.ts` |
| `/myna` | `myna/page.tsx` → `MynaAdminPage` | staff、handoff/account scope | electronic prescription handoff、verification、endpoint | verification/configuration。CSRF、stale/error | PHI / actor audit / `MynaAdminPage.test.tsx`, `v032-a2-contract.test.ts` |
| `/emergency-contraception` | `emergency-contraception/page.tsx` → `EmergencyContraceptionAdminPage` | staff、trained pharmacist gate | config、reminders、slots、inventory、intake/sale | pharmacist-only workflow、sale。CSRF、confirmation、state | PHI / workflow/sale actor / `EmergencyContraceptionAdminPage.test.tsx`, `api.test.ts`, `v032-a2-contract.test.ts` |
| `/pharmacy-notifications` | `pharmacy-notifications/page.tsx` → `PharmacyActivityNotificationsPage` | staff/account scope | pharmacy activity、ack state | acknowledge。CSRF、server actor/account | PHI / acknowledgement actor/time / page・API tests |
| `/continuity` | `continuity/page.tsx` → `ContinuityAdminPage` | staff、patient/account scope | continuity queue、expectations | create/end expectation。CSRF、state/stale | PHI / transition actor / page test、`v032-a2-contract.test.ts` |
| `/patient-intakes` | `patient-intakes/page.tsx` → `PatientIntakeAdminPage` | staff、encrypted intake tenant/account scope | patient list/history/intake | admin intake workflow。CSRF、encrypted readback、stale | PHI / intake actor/scope / page・API・labels tests |
| `/privacy-policy` | `privacy-policy/page.tsx` → `PrivacyPolicyAdminPage` | staff/account scope | tenant policy/revision | update policy。CSRF、revision | none / policy revision / API・UI safety tests |
| `/data-subject-requests` | `data-subject-requests/page.tsx` → `DataSubjectRequestAdminPage` | privacy staff、request ownership | request、identity/legal-hold/resolution | create/verify/hold/resolve。CSRF、identity、legal hold | PHI / lifecycle actor / page・API tests |
| `/pharmacy-features` | `pharmacy-features/page.tsx` → `FeatureSettingsPage` | tenant-admin capability/account scope | capabilities、readiness、rich-menu status | configuration。CSRF、revision/CAS | operational-sensitive / config actor/revision / `FeatureSettingsPage.test.tsx`, `v032-a2-contract.test.ts` |
| `/pharmacy-info` | `pharmacy-info/page.tsx` → `PharmacyInfoAdminPage` | staff/account scope | patient-facing profile | update profile。CSRF、revision | none / profile actor/revision / page・API tests |
| `/pharmacy-growth` | `pharmacy-growth/page.tsx` → `GrowthDashboardPage` | dashboard capability/account scope | metrics、sources、submission validity | source/validity changes。CSRF、state/revision | operational-sensitive / actor/account / `GrowthDashboardPage.test.tsx`, `tenant-admin-ux.test.ts` |
| `/friends` | `friends/page.tsx` | staff、friend/account ownership | friend、tags、mileage、messages | tag/metadata、manual message。manual confirmation/header | PHI / tenant boundary + source tests / `ui-safety.test.ts`, `menu.test.ts` |
| `/chats` | `chats/page.tsx` | staff、chat/friend tenant pair | messages、operator/loading、failure | manual one-to-one send。`window.confirm`、single-flight、`X-Line-Harness-Source: manual` | PHI / cross-tenant + manual-message tests / `chats/page.test.ts`, `v032-a2-contract.test.ts` |
| `/notifications` | `notifications/page.tsx` | staff、inbox/account scope | inbox/unanswered summary | read-only | operational-sensitive / read audit boundary / `menu.test.ts`, `ui-safety.test.ts` |
| `/rich-menus` | `rich-menus/page.tsx` + pharmacy panel | staff、capability/account ownership | groups、layout、versions、diff、lifecycle | draft/version/publish/apply。CSRF、CAS、external confirmation | operational-sensitive / operation/reconcile audit / panel・menu・UI safety tests |
| `/staff` | `staff/page.tsx` | tenant-admin for administration、server tenant membership | staff、roles、assignments、active state | create/update/disable/delete/reset。CSRF、destructive confirmation | operational-sensitive / staff/session audit / `staff/page.test.ts`, `tenant-admin-ux.test.ts` |
| `/accounts` | `accounts/page.tsx` | staff、server account ownership | LINE metadata/status/readiness | connect/update/order/settings。CSRF、confirmation、redaction | credentials / connection/config audit / UI safety、line connection、rich-menu tests |

`menu.ts` の pharmacy allowlist と `sidebar.tsx` の `pharmacyOnly` path はテストで全件 page inventory に照合します。一般画面のうち pharmacy allowlist 外の `/tags` は API inventory で `deferred` として残し、到達可能と誤表示しません。

### Patient pharmacy LIFF

| path | component | role・authority | 表示/操作 | PHI / confirmation / test |
| --- | --- | --- | --- | --- |
| `/pharmacy/menu` | `menu/MainMenuPage.tsx` | verified LINE patient、server LIFF/account/friend binding | enabled/existing-only feature と3つの利用目的 | PHI-free-default、送信時再確認 / menu・V032 contract tests |
| `/pharmacy/timeline` | `timeline/PatientTimelinePage.tsx` | verified LINE patient、server owner/account binding | 既存4domainのPHI最小化statusと固定next action | PHI-free-default、read-only/no-store / page・request tests |
| `/prescriptions` | `prescriptions/PrescriptionPage.tsx` | verified LINE patient、server prescription owner/account scope | 手順、履歴、状態、到着/取消等 | PHI、consent・idempotency・CAS・single-flight / page・API tests |
| `/pharmacy/patient-intake` | `intake/PatientIntakePage.tsx` | verified LINE patient、server patient/friend/account ownership | profile、3段階問診、最新回答 | PHI、必須回答・同意・memory-only draft / page・V032 contract tests |
| `/pharmacy/continuity` | `continuity/ContinuityPage.tsx` | verified LINE patient、server continuity owner/account scope | 継続状態、次の行動、回答/休止 | PHI、existing-only・state/idempotency / page test |
| `/pharmacy/medication-followup` | `medication-followup/MedicationFollowUpPage.tsx` | verified LINE patient、server follow-up owner/account scope | フォロー状態、回答、次の行動 | PHI、existing-only・single-flight / page test |
| `/pharmacy/emergency-contraception` | `emergency-contraception/EmergencyContraceptionPage.tsx` | verified LINE patient、server EC owner/account + readiness gate | 利用可否、問診状態、次の行動 | PHI、consent・feature/readiness・state / page test |
| `/pharmacy/info` | `public-profile/PharmacyInfoPage.tsx` | unique server LIFF/account resolution | 公開薬局情報、privacy policy link | none、read-only/no-store / page test |
| `/pharmacy/receive` | `navigation.ts` | client redirect。遷移先で通常のLINE/server authorityを検証 | 旧URLからtenantを保った処方せん画面へ移動 | none、mutationなし / navigation・V032 contract tests |

### Platform admin

| path | source | role・authority | 表示/操作 | PHI / confirmation / test |
| --- | --- | --- | --- | --- |
| `/platform-admin/login` | `platform-admin/login/page.tsx` | Platform admin credential/session | login/password change | PHI-free-default、platform CSRF / `platform-admin-ui.test.ts` |
| `/platform-admin` | `platform-admin/page.tsx` | Platform admin session | tenant/account/readiness/webhook/version counters | PHI-free-default、read audit / UI safety・UI test |
| `/platform-admin/tenants` | `platform-admin/tenants/page.tsx` | Platform admin、tenant id は server validated selector | tenant status、counts、issues、support/retry actions | PHI-free-default、CSRF、reason/confirmation/retry safety / UI・label・readiness tests |
| `/platform-admin/tenants/new` | `platform-admin/tenants/new/page.tsx` | Platform admin provisioning authorization | tenant/LINE setup、receipt | credentials、human confirmation、idempotent request hash / `platform-admin-ui.test.ts` |
| `/platform-admin/tenants/detail` | `platform-admin/tenants/detail/page.tsx` | Platform admin、support grant が患者 read を gate | health、LINE/webhook、staff/support controls | PHI-free-default、CSRF、grant reason、destructive/external confirmation / UI safety・UI test |
| `/platform-admin/tenants/patients` | `platform-admin/tenants/patients/page.tsx` | Platform admin + active purpose-bound support grant | minimum patient list identifiers | PHI-with-support-grant、list is read-only、access audit / UI safety・UI test |
| `/platform-admin/tenants/patients/detail` | `platform-admin/tenants/patients/detail/page.tsx` | Platform admin + active purpose-bound support grant | patient/intake/history permitted detail | PHI-with-support-grant、banner/grant/CSRF/audit、no silent escalation / UI safety・UI test・intake labels |
| `/platform-admin/logs` | `platform-admin/logs/page.tsx` | Platform admin、filters are selectors | webhook/prescription/access logs | PHI-free-default、patient audit detail redacted / UI safety・UI test |
| `/platform-admin/audit` | `platform-admin/audit/page.tsx` | Platform admin、filters are selectors | actor/action/tenant/time/redacted detail | PHI-free-default、server audit trail display / UI safety・UI/labels tests |

## API inventory

以下は route source ごとに、source から抽出した全ての route pattern を列挙したものです。`${phase}` のような loop variable は、機械 inventory では `:phase` として一つの pattern に正規化しています。各 group の role、scope、mutation、confirmation、PHI、audit、test reference は script の entry に保持され、テストで空欄・不存在を拒否します。

### Patient pharmacy LIFF APIs

| source group | 全 route patterns | role・scope / mutation・confirmation / PHI・test |
| --- | --- | --- |
| `routes/liff/liff.ts` | `GET /api/liff/config`; `GET /api/liff/pharmacy/feature-access` | unique LIFF resolution。feature access は verified LINE subject + friend/account binding / read-only、PHI-free-default; OAuth boundary・feature access tests |
| `patient-timeline/routes.ts` | `GET /api/liff/pharmacy/timeline` | verified LINE owner/account scope; bounded allowlist projection、fixed destination、read-only/no-store / PHI-free-default; route・boundary tests |
| `prescriptions/routes.ts` | `GET /api/liff/pharmacy/prescriptions/me`; `POST /api/liff/pharmacy/prescriptions`; `POST .../:id/arrival`; `POST .../:id/cancel`; `POST .../:id/resubmission`; `POST .../:id/submit`; `PUT .../:id/files/:position` | patient owner/account scope; consent、idempotency、CAS、R2 checksum / PHI; route・boundary tests |
| `intake/routes.ts` | `GET/POST /api/liff/pharmacy/patients`; `GET/PATCH .../patients/:id`; `POST .../:id/archive`; `GET/POST .../:id/intake` | patient/friend/account ownership; encrypted-write-first、revision validation / PHI; route・repository tests |
| `continuity/routes.ts` | `GET /api/liff/pharmacy/continuity`; `POST .../continuity/:id/pause`; `POST .../continuity/expectations/:id/respond` | continuity owner/account scope; existing-only、state/idempotency / PHI; route test |
| `myna/routes.ts` | `GET /api/liff/pharmacy/myna-handoffs/active`; `POST .../myna-handoffs`; `POST .../:id/launch`; `POST .../:id/patient-report` | handoff owner/account scope; one-active、signed launch、state checks / PHI; route test |
| `medication-followup/routes.ts` | `GET /api/liff/pharmacy/medication-followups`; `POST .../:id/respond` | follow-up owner/account scope; existing-only、state/idempotency / PHI; route・pagination tests |
| `emergency-contraception/routes.ts` | `GET /api/liff/pharmacy/emergency-contraception`; `POST .../intakes`; `POST .../intakes/:id/cancel` | EC owner/account + operational readiness; consent hash、encrypted payload、state checks / PHI; route test |
| `privacy-policy/routes.ts` | `GET /api/liff/pharmacy/privacy-policy` | unique server LIFF/account resolution; read-only/no-store / none; route test |
| `public-profile/routes.ts` | `GET /api/liff/pharmacy/public-profile` | unique server LIFF/account resolution; safe read-only projection / none; route test |

### Tenant pharmacy admin / generic admin APIs

| source group | route patterns | role・scope | mutation / confirmation | PHI・test |
| --- | --- | --- | --- | --- |
| `routes/admin/admin-auth.ts` | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/change-password` | unauthenticated/tenant staff。server session | credential、CSRF、timing-safe failure | none / middleware auth・provisioning admin-auth |
| `routes/admin/account-settings.ts` | `GET/PUT /api/account-settings/test-recipients`, `GET/PUT /api/account-settings/link-base-url`, `GET/PUT /api/account-settings/tracked-link-base-url` | tenant-admin、server account selector validation | CSRF、tenant-admin、server settings validation | operational-sensitive / `account-settings-tenant-scope.test.ts` |
| `routes/admin/capabilities.ts` | `GET /api/capabilities` | authenticated tenant staff。server tenant contextから薬局機能を分類 | read-only capability/version/endpoint discovery | none / capabilities・Platform admin API coverage tests |
| `routes/admin/images.ts` | `POST /api/images`; `GET/DELETE /api/images/:key{.+}`; `GET /images/:key{.+}` | 薬局uploadは認証済みstaffのserver assignmentでaccountを検証。公開keyとprivate incoming keyを分離 | MIME/size/key検証、R2前audit。薬局tenantのDELETEは拒否 | operational-sensitive / images・generic feature guard tests |
| `routes/admin/line-accounts.ts` | `GET /api/line-accounts`, `GET /api/line-accounts/:id`, `GET /api/line-accounts/:id/follower-insight`, `GET /api/line-accounts/:id/follower-import`, `POST /api/line-accounts`, `POST /api/line-accounts/:id/connect`, `POST /api/line-accounts/:id/follower-import/detect`, `POST /api/line-accounts/:id/follower-import/start`, `POST /api/line-accounts/:id/follower-import/step`, `PATCH /api/line-accounts/order`, `PATCH /api/line-accounts/:id`, `PUT /api/line-accounts/:id`, `DELETE /api/line-accounts/:id` | staff/admin、server `tenant_line_accounts` ownership | connect/import/update、CSRF、confirmation、progress/idempotency、secret redaction | credentials / `line-accounts.test.ts`, tenant-boundary |
| `routes/admin/staff.ts` | `GET /api/staff/me`, `GET /api/staff`, `GET /api/staff/:id`, `GET /api/staff/:id/accounts`, `POST /api/staff`, `PATCH /api/staff/:id`, `DELETE /api/staff/:id`, `POST /api/staff/:id/reset-password`, `PUT /api/staff/:id/accounts` | tenant-admin/staff、server tenant/account assignment | staff administration、CSRF、role/destructive confirmation | operational-sensitive / staff tenant/profile tests |
| `routes/crm/friends.ts` | `GET /api/friends`, `GET /api/friends/count`, `GET /api/friends/ref-stats`, `GET /api/friends/:id`, `GET /api/friends/:id/mileage`, `GET /api/friends/:id/messages`, `POST /api/friends/:id/tags`, `DELETE /api/friends/:id/tags/:tagId`, `PUT /api/friends/:id/metadata`, `POST /api/friends/:id/messages` | staff、friend/account ownership。query ids are selectors | tags/metadata/manual 1:1 send。CSRF、confirmation、`X-Line-Harness-Source: manual` | PHI / friend tenant/manual-message tests |
| `routes/crm/tags.ts` | `GET /api/tags`, `POST /api/tags`, `PATCH /api/tags/:id/mileage`, `DELETE /api/tags/:id` | staff、server tenant/account scope。pharmacy menu allowlist 外 | tag/mileage mutation、CSRF、destructive confirmation | operational-sensitive、`deferred` / generic-feature guard |
| `routes/crm/inbox.ts` | `GET /api/inbox/activity-digest`, `GET /api/inbox/unanswered`, `GET /api/inbox/unanswered/count` | staff、server inbox/account scope | read-only | operational-sensitive / generic-feature guard |
| `routes/crm/chats.ts` | `GET /api/chats`, `GET /api/chats/:id`, `POST /api/chats`, `PUT /api/chats/:id`, `POST /api/chats/:id/loading`, `POST /api/chats/:id/send`, `GET/POST/PUT/DELETE /api/operators`（`GET/POST /api/operators`, `PUT/DELETE /api/operators/:id`） | staff、chat/friend tenant pair | assignment/loading/manual send。CSRF、single-flight、confirm、manual header | PHI / chats list/manual/pair tests |
| `routes/crm/conversations.ts` | `GET /api/conversations`, `GET /api/conversations/:friendId` | staff、friend/account ownership | read-only | PHI / `conversations-tenant-scope.test.ts` |
| `routes/messaging/rich-menu-groups.ts` | `GET /api/rich-menu-groups`, `GET /api/rich-menu-groups/:groupId`, `POST /api/rich-menu-groups`, `PATCH /api/rich-menu-groups/:groupId`, `DELETE /api/rich-menu-groups/:groupId`, `POST /api/rich-menu-groups/import`, `POST /api/rich-menu-groups/:groupId/pages/:pageId/image`, `POST /api/rich-menu-groups/:groupId/publish`, `POST /api/rich-menu-groups/:groupId/unpublish`, `POST /api/rich-menu-groups/:groupId/apply-to-tag`, `GET /api/rich-menu-groups/external`, `DELETE /api/rich-menu-groups/external/:richMenuId`, `GET /api/rich-menu-groups/external/:richMenuId/image`, `GET /api/rich-menu-images/:key{.+}`, `POST /api/rich-menu-groups/operations/:operationId/reconcile`, `POST /api/rich-menu-groups/operations/:operationId/resume` | staff、group/account ownership | upload/publish/external apply、CSRF、CAS/operation reconcile、explicit external confirmation | operational-sensitive / rich-menu route tests |
| `routes/booking/meet-consultations.ts` | `GET /api/meet-consultations`, `POST /api/meet-consultations`, `DELETE /api/meet-consultations/:externalEventId` | authenticated tenant、staff account assignment、`tenant_line_accounts` から server-side scope。friend/event id は selector のみ | Calendar event 登録、cancel、reminder follow-up。human confirmation必須 | operational-sensitive / route account-scope negative tests |

### Custom pharmacy APIs

| source group | 全 route patterns | role・scope / mutation・confirmation / PHI・test |
| --- | --- | --- |
| `activity-notifications/routes.ts` | `GET /api/custom/pharmacy/activity-notifications`; `POST /api/custom/pharmacy/activity-notifications/:id/ack` | staff/account scope; ack は CSRF・actor validation / PHI; `activity-notifications/routes.test.ts` |
| `continuity/routes.ts` | `GET /api/custom/pharmacy/continuity`; `POST /api/custom/pharmacy/continuity/:id/expectations`; `POST /api/custom/pharmacy/continuity/:id/expectations/:expectationId/end` | staff、patient/account scope; expectation workflow は CSRF/state/CAS / PHI; `continuity/routes.test.ts` |
| `data-subject-requests/routes.ts` | `GET/POST /api/custom/pharmacy/data-subject-requests`; `POST .../:id/identity-verification`; `POST .../:id/legal-hold-assessment`; `POST .../:id/resolution` | privacy staff、request ownership; identity/legal-hold/resolution gate / PHI; `data-subject-requests/routes.test.ts` |
| `emergency-contraception/routes.ts` | `GET/PUT /api/custom/pharmacy/emergency-contraception/config`; `GET/PUT .../reminders`; `PUT .../pharmacists/:staffId`; `POST .../slots`; `POST .../slots/:id/cancel`; `PUT .../inventory`; `GET .../intakes`; `GET .../intakes/:id`; `POST .../intakes/:id/transitions`; `GET/PUT .../intakes/:id/counter-confirmations/:section`; `POST/GET .../intakes/:id/sale` | staff + trained pharmacist gate; config/inventory/slot/intake/sale mutation; CSRF、confirmation、state/version / PHI; `emergency-contraception/routes.test.ts` |
| `fulfillment/routes.ts` | `GET/POST /api/custom/pharmacy/fulfillment-quotes/:submissionId` | staff/submission/account scope; quote mutation は CSRF/state / PHI; `fulfillment/routes.test.ts` |
| `growth-loop/routes.ts` | `GET /api/custom/pharmacy/growth/config`; `PUT .../growth/config`; `GET /api/custom/pharmacy/readiness`; `GET .../active-work`; `GET .../operations-summary`; `GET .../growth/dashboard`; `GET/POST .../growth/sources`; `PATCH .../growth/sources/:sourceId`; `POST .../growth/submissions/:submissionId/source`; `PUT .../growth/submissions/:submissionId/validity` | staff/capability/account scope; config/source/submission mutation は CSRF/revision/state / operational-sensitive; `growth-loop/routes.test.ts` |
| `intake/routes.ts` | `GET /api/custom/pharmacy/patients`; `GET .../patients/:id`; `GET .../patients/:id/history`; `GET .../patients/:id/intake` | staff、encrypted tenant/account scope; patient id は selector / PHI; `intake/routes.test.ts` |
| `medication-followup/routes.ts` | `POST /api/custom/pharmacy/medication-followups`; `POST .../medication-followups/:id/transitions` | staff/submission/account scope; create/transition は CSRF/state / PHI; `medication-followup/routes.test.ts` |
| `myna/routes.ts` | `GET /api/custom/pharmacy/myna-handoffs`; `GET .../myna-handoffs/:id`; `POST .../:id/verifications`; `GET/PUT/PATCH /api/custom/pharmacy/myna-endpoint`; `POST .../myna-endpoint/verification` | staff/account scope; verification/config mutation は CSRF/state / PHI; `myna/routes.test.ts` |
| `print/routes.ts` | `POST /api/custom/pharmacy/print/submissions/:id/prepare`; `POST .../print/tasks/:id/claim`; `POST .../print/tasks/:id/ack` | staff/submission/account scope; task transition は CSRF/state / PHI; `print/routes.test.ts` |
| `privacy-policy/routes.ts` | `GET/PUT /api/custom/pharmacy/privacy-policy` | staff/account scope; revision-aware update / none; `privacy-policy/routes.test.ts` |
| `public-profile/routes.ts` | `GET/PUT /api/custom/pharmacy/public-profile` | staff/account scope; revision-aware update / none; `public-profile/routes.test.ts` |
| `prescriptions/routes.ts` | `GET /api/custom/pharmacy/prescriptions`; `GET .../prescriptions/stats`; `GET .../prescriptions/:id`; `GET .../prescriptions/:id/files/:fileId`; `POST .../prescriptions/:id/actions/:action` | staff、`prescriptionLineAccountId` scope; workflow/binary access は CSRF/action/state / PHI; `prescriptions/routes.test.ts`, boundary |
| `rich-menu/routes.ts` | `GET/PUT /api/custom/pharmacy/rich-menus/layout`; `GET .../candidate`; `GET .../candidate/image`; `GET/PUT .../lifecycle`; `GET .../versions`; `GET .../versions/:groupId/diff`; `PATCH/DELETE .../versions/:groupId`; `POST .../versions`; `POST .../prepare`（retired 410） | staff/capability/account scope、Platform admin は tenant route で拒否; CAS、external cleanup、CSRF / operational-sensitive; `rich-menu/routes.test.ts` |

### Platform admin / provisioning APIs

| source group | 全 route patterns | role・scope / mutation・confirmation / PHI・test |
| --- | --- | --- |
| `provisioning/routes.ts` | `POST /api/platform/pharmacy/tenants`; `POST /api/platform-admin/tenants`; `POST /api/platform/pharmacy/tenants/:tenantId/admin-bootstrap`; `POST .../:tenantId/cli-sessions`; `POST .../:tenantId/cli-sessions/:sessionId/revoke`; `POST /api/platform/pharmacy/platform-admins`; `POST .../:tenantId/line-accounts/:lineAccountId/credentials/:phase`; `POST .../:tenantId/line-accounts/:lineAccountId/intake-encryption/:phase` | Platform/tenant admin、server tenant/account binding; provisioning、break-glass、credential/encryption migration。human approval/ticket、CSRF、idempotency、production gate / credentials; routes、admin-auth、CLI break-glass tests |
| `platform-admin/routes.ts` | `POST /api/platform-admin/login`; `POST /api/platform-admin/logout`; `GET /api/platform-admin/session`; `POST /api/platform-admin/change-password`; `GET /api/platform-admin/tenants`; `GET/PATCH /api/platform-admin/tenants/:id`; `POST /api/platform-admin/tenants/:id/outbound-messaging`; `POST /api/platform-admin/tenants/:id/webhook-events/:webhookEventId/retry`; `POST /api/platform-admin/tenants/:id/support-grants`; `POST /api/platform-admin/support-grants/:grantId/end`; `GET /api/platform-admin/support-grants/active`; `GET /api/platform-admin/tenants/:id/patients`; `GET /api/platform-admin/tenants/:id/patients/:patientId`; `GET /api/platform-admin/logs`; `GET /api/platform-admin/audit` | Platform admin session/CSRF、tenant/path ownership; tenant operation、support grant、retry。reason/ticket、explicit confirmation、audit / default PHI-free except support-grant patient paths; `platform-admin/routes.test.ts`, `api-coverage.test.ts` |
| `dashboard-routes.ts` | `GET /api/platform-admin/dashboard`; `GET /api/platform-admin/tenants/:id/health`; `GET /api/platform-admin/integrity` | Platform admin、server tenant/account mapping; read-only / PHI-free-default、access audit; `dashboard-routes.test.ts` |
| `operations-routes.ts` | `GET /api/platform-admin/tenants/:id/staff`; `POST /api/platform-admin/tenants/:id/staff/:staffId/disable`; `POST /api/platform-admin/tenants/:id/revoke-sessions`; `GET /api/platform-admin/tenants/:id/line-status`; `POST /api/platform-admin/tenants/:id/line-accounts/:lineAccountId/test-connection` | Platform admin、server tenant/staff/account path scope; disable/revoke/test connection。CSRF、confirmation、secret redaction / credentials; `operations-routes.test.ts` |
| `data-protection-routes.ts` | `POST /api/platform-admin/data-protection/recovery-operations`; `POST .../:operationId/preflight`; `POST .../:operationId/approve`; `POST .../:operationId/execute`; `GET .../:operationId` | Platform admin recovery workflow; `platformAdminAuthMiddleware` 後に mount; preflight/approval/CAS/idempotency/data-loss human gate / credentials; `data-protection-routes.test.ts` |

## 必須の安全境界と未検証事項

### query parameter と `line_account_id`

`accountId`、`lineAccountId`、`line_account_id`、patient/friend/submission id は selector です。値を query に渡しただけでは tenant/account authority になりません。server 側で authenticated staff/platform-admin の権限、`tenant_line_accounts` の ownership、対象 resource の tenant/account 所有を検証する必要があります。inventory の `queryAuthority` が `selector-only-server-validated` の entry はこの境界を明示しています。

### PHI と privileged operation

- 処方せん、患者 intake、Myna handoff、継続フォロー、緊急避妊、DSR、chat/message は `PHI` として扱います。
- Platform admin の通常 dashboard/tenant/log/audit は `PHI-free-default` です。患者 list/detail だけは purpose-bound、期限付き support grant が必須の `PHI-with-support-grant` です。
- credential、LINE connection、provisioning、staff/connection operation は `credentials` とし、画面表示の redaction と human/CSRF gate を含めます。

### Manual one-to-one message

`POST /api/friends/:id/messages` と `POST /api/chats/:id/send` および `/friends`・`/chats` の send flow は、予約通知や自動送信とは分離した担当者の個別返信です。UI の明示確認、single-flight/failure retention、`X-Line-Harness-Source: manual` を必須分類に残しています。

### Meet consultation follow-up

`/api/meet-consultations` は `GET/POST/DELETE` を inventory しました。list は authenticated tenant とstaffのaccount assignmentに限定し、登録と取消は friend/event selector をserver-sideで所有 LINE accountへ解決した後、shared serviceでもexact `line_account_id`を再確認します。相談本体と前日・1時間前リマインドは同じD1 batchで登録します。Google Calendar event ID、LINE friend ID、日時、Meet URL の登録後に、前日・1時間前リマインドをセットし、cancel 時は `DELETE /api/meet-consultations/:externalEventId` が必要です。実際の Google Calendar/LINE/Meet 操作はこの inventory の検証範囲外です。

### Mounted recovery route

`data-protection-routes.ts` は `apps/worker/src/index.ts` で `platformAdminAuthMiddleware` より後に mount されています。静的 inventory test は import、mount、middleware の順序を確認します。

## 検証コマンド

```sh
pnpm exec vitest run --config vitest.config.mts scripts/deploy/v032-route-inventory.test.ts
```

このテストは次を検査します。

1. 全 custom pharmacy route source の欠落・重複
2. route source から抽出した `METHOD path-pattern` の重複・実在
3. Platform admin page、patient LIFF page/API、pharmacy menu/sidebar path の欠落
4. page/component/route/test reference の実在
5. role、scope、`line_account_id` authority、表示情報、mutation、confirmation、PHI、audit、reachability の必須フィールド
6. query selector 境界、manual one-to-one header、Meet follow-up、support-grant PHI、mounted recovery route
