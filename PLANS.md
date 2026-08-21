# Plans

## Active

### V029 - 電子処方箋・緊急避妊薬・機能ON/OFF + 安全なreadiness - 2026-08-21 Oracle反映版

**基準**: `dev` / `0b9cffff5d002f6e5eae716690bbfd134c0c3427`。seller releaseは`pharmacy-v0.29.0`を予定するが、package versionと`CHANGELOG.md`はrelease準備時にだけ更新する。schema適用、code deploy、account別機能activation、LINE mutationは別々の明示Human Gateとし、一つの承認から次を推測しない。

**目的**: 既存Myna handoff・処方箋受付を患者LIFFへ安全に配線し、緊急避妊薬Phase 1を最小情報のqueue/detailと患者statusまで拡張する。staff-triggered中立通知は既存のaccount-scoped atomic outbox/idempotency経路を再利用して安全contractを満たせる場合だけ同梱する。既存`pharmacy_account_capabilities`を使って薬局ごとの患者向け機能ON/OFFを管理し、OFF後も履歴と対応中案件を孤立させない。LIFFの全機能一覧はaccount設定へ連動させ、薬局管理画面と全体管理者画面は同じ非PHI readinessを利用する。v0.29.0では可変rich menu、scheduled reminder、repository移動・renameを混ぜず、security-sensitiveな機能差分を小さく保つ。

**Oracle反映**:

| 判断 | v0.29.0での扱い |
|---|---|
| `KEEP` | 既存Myna/prescription model再利用、緊急避妊薬status/queue、account-scoped ON/OFF、LIFF連動、非PHI readiness |
| `CHANGE` | capability互換・migrationとatomic admission/drainを全患者機能より先行 |
| `CHANGE` | platform adminはrich-menu prepareを実行せず、非PHI readだけに限定 |
| `DEFER` | 時刻起点の緊急避妊薬reminder |
| `DEFER` | account別6枠配置、画像生成、LINE draft/publish/default同期 |
| `DEFER` | folder/file rename、repository再配置、公開route rename |

**判定語**:

| 状態 | 意味 | release判断 |
|---|---|---|
| `READY` | 自動検証できる必須条件が満たされている | 次のgateへ進める |
| `BLOCKED` | 欠落・不整合を自動検出した | 修正まで停止 |
| `UNVERIFIED` | 外部設定を安全に確認できる証拠がない | account activationを停止してHuman Gateへ送る |

`UNVERIFIED`が残るaccountは新機能をONにしない。新capabilityがdefault OFFかつserver-side fail closedなら、他accountを含むsoftware artifact作成全体までは止めない。

**非目標**: 電子処方箋本文、マイナンバーカード情報、引換番号、処方内容の取得・保存・解析、AI/OCR、新しい処方箋model、販売可否自動判定、メーカー紙記録の電子置換、配送・決済。PHIを含む通知・platform health、shared LIFF buildへのtenant固有ID埋込み、非公式LINE API、任意URL/message/imageのmenu builder、config保存・health・preflight・cronからのLINE mutation、全repoのformat/renameも行わない。

**患者向け機能とcapabilityの正規mapping**:

| 患者向け表示 | capability | OFF時の新規操作 | OFF前の既存案件 |
|---|---|---|---|
| 処方せん事前送信 | 既存`prescription_intake` | 新規送信を409拒否 | 受付状況・取消を維持 |
| 電子処方箋 | 新規`electronic_prescription` | 新規handoffを409拒否 | resume/report/cancel/紙fallbackとstaff完了を維持 |
| 受付状況 | authenticated projection | 新規受付を作らない | owned history/statusを維持 |
| 患者情報・アンケート | 既存`patient_intake` | 新規回答を409拒否 | 既存回答のauthorized readを維持 |
| 継続フォロー | 既存`continuity` | 新規開始・periodic reminderを停止 | terminalize/expireを維持 |
| 服薬後フォロー | 既存`medication_followup` | 新規開始・periodic reminderを停止 | terminalize/expireを維持 |
| 緊急避妊薬 | 新規`emergency_contraception` | 新規仮受付を409拒否 | owned status/cancelとstaff完了を維持 |
| 薬局へ相談 | 既存`manual_chat` | 新規固定message導線を停止 | データ削除なし |
| 薬局情報 | 新規`pharmacy_info` | 患者向け詳細を停止 | 保存済みprofileを削除しない |

`account_settings`、`pharmacy_dashboard`、`pharmacy_rich_menu`等の管理用capabilityは患者機能ON/OFF画面へ出さない。capability ONは新規受付の必要条件であり、Myna endpoint、研修修了薬剤師、在庫、枠、患者所有権、domain state等のoperational readinessを代替しない。

**OFF時のoperation matrix**:

| 操作 | 契約 |
|---|---|
| 新規record/handoff/intake作成 | 最終write境界で`409 FEATURE_DISABLED` |
| owned既存record/history/status read | 許可 |
| 既存active recordのallowlist済み完了・取消 | 許可 |
| closed recordのreopen、新しいchild/reminder作成 | 拒否 |
| 既存recordのexpire/cleanup/terminalize | capability OFFでも継続 |
| periodic reminder生成 | 停止 |
| 既存案件の明示status通知 | drain policyとcontact modeをsend直前に再検証 |
| 別tenant/account | `404` |
| staff role不足 | `403` |
| stale capability/state revision | `409` |

- [x] **V029-0 現行契約・previous-version互換・Red testを固定**
  - 電子処方箋は既存`pharmacy_myna_handoffs` -> patient report -> staff verification -> `pharmacy_prescription_submissions` shadow submissionを正とする。patient reportと薬局受領を別事実として固定し、patient操作では`shadow_submission_id`、`E_PRESCRIPTION_RECEIVED`、受付完了表示を作らない。
  - 緊急避妊薬は既存の暗号化最小申告、枠、研修修了薬剤師、在庫、Human Gateを正とし、capability ONから販売可否・在庫確保・予約確定を推論しない。
  - frozen v0.28相当parserで、新keyを含むv0.29 `capabilities_json`を読み、未知keyが他の既知機能を無効化・有効化しない互換testを作る。greenにできなければ先行expand releaseを必須にし、同一releaseでdataを書かない。
  - 現行`MainMenuPage`の固定表示、緊急避妊薬routeのcapability未適用、middlewareがplatform adminをrich-menu prepareへ通した後route内403となる状態を実middleware/routeで固定する。
  - config保存、LIFF config、health、preflightがLINE APIを呼ばないzero-call contractを固定する。
  - **受入条件**: previous-version compatibility、Myna patient/staff境界、EC Human Gate、tenant/account denial、zero-LINE-callがRed testとして再現する。

- [x] **V029-1 LINE Developers Endpointのread-only契約を先に決定**
  - 公式API、credential、scope、rate limitで対象LINE Login channelのLIFF Endpoint URLをread-only取得できるか一次資料で確認する。非公式endpointやrich-menu URLから実Endpointを推測しない。
  - 現行暗号化credentialだけで安全に確認できる公式契約がある場合のみ、既存decrypt pathをWorker内で再利用する。追加権限が必要、または公式read契約がなければ`UNVERIFIED` + Console Human Gateを維持する。
  - Endpoint更新APIはv0.29.0へ入れず、read確認とmutationを分離する。
  - **受入条件**: 公式contractと実装可否を記録し、実装しない場合も`UNVERIFIED`理由とmanual evidence手順が残る。
  - **実装判断**: LINE Developers公式のLIFF Server API `Get all LIFF apps`はLINE Login channel access tokenを要求する。現行の暗号化credentialはLogin channel secretまでで、追加token発行・権限拡張は本版の範囲外のため、自動確認は行わず`UNVERIFIED` + LINE Developers Consoleのmanual evidenceを維持する。参照: https://developers.line.biz/en/reference/liff-server/#get-all-liff-apps

- [x] **V029-2 capability互換・migration・rollbackを実装**
  - 新flag frameworkは作らず、既存`pharmacy_account_capabilities.capabilities_json`、fail-closed parser、owner-only config API、監査eventを再利用する。新keyは`electronic_prescription`、`emergency_contraception`、`pharmacy_info`だけに限定する。
  - 加算migrationはidempotentにする。`electronic_prescription`は全account default OFF。緊急避妊薬は既存`is_enabled`の現在の公開状態だけを保存して新規exposureを増やさない。薬局情報はprofile有無だけで暗黙ONにせず、v0.28の既存公開契約を明示したbackfill ruleで扱う。
  - 緊急避妊薬の旧`is_enabled`は初回backfill後、rollback互換のためcapabilityから旧列への一方向mirrorだけを残す。旧列のINSERT/UPDATEからowner-only capabilityへ逆流させない。capability更新、legacy mirror、revision、auditを同じatomic boundaryへ置く。
  - patient featureが0件でも管理capabilityは保持できるようvalidationを分離し、clientからの未知keyと管理key変更を拒否する。
  - **Red -> Green**: frozen reader、migration再実行、default OFF、既存exposure維持、unknown key、管理key保護、stale revision、別tenant/account、atomic mirror/auditを確認する。

- [x] **V029-3 atomic admission・drain・薬局ON/OFF UIを先行実装**
  - owner向け「機能設定」を追加し、server-owned allowlistで公開準備ができた患者機能だけをswitch表示する。OFF確認には新規停止、既存データ非削除、対応中件数とdrain挙動を表示する。
  - capability checkはmiddleware表示制御だけで終えず、各create/startの最終writeへcurrent capability predicate/revisionを含める。disableとcreateが競合した場合は「createが先に成立」または「disableが先に成立してcreateが409」の二結果だけを許す。
  - cronをadmission/generation、lifecycle/drain、notification dispatchへ分ける。OFFは新規/reminder生成だけを止め、既存recordのexpire/cleanup/terminalizeは継続する。1 accountのdisabled/corrupt状態で他account batchを中断しない。
  - notification dispatchはsend直前にaccount、row state、contact mode、event policy、capability/drain policyを再確認する。
  - 44px target、keyboard、保存中二重送信、未保存変更、account切替、CAS conflict後の再取得を扱う。
  - **Red -> Green**: 全operation matrix、disable/create race、active drain、cron分離、通知直前再確認、全OFF、他機能/他account継続をtable-driven testで確認する。

- [x] **V029-4 電子処方箋を既存処方箋LIFFへ配線**
  - `/prescriptions`で「紙の処方せんを撮影」「電子処方箋を利用」を選ぶ。紙は既存upload、電子は既存`mynaApi`とserver-side patient/account ownershipを再利用する。
  - 説明 -> 外部Myna受付 -> active handoff resume -> patient report/cancel/紙fallbackへつなぐ。外部URLへpatient/friend/LIFF IDを渡さない。
  - patient reportはpatient-reported stateだけを更新し、staff verification前に「受付完了」、shadow submission、薬局受領eventを作らない。
  - OFF後も既存active handoffのresume/report/cancel/紙fallbackを許可し、二つ目のhandoffは作らない。
  - **Red -> Green**: ownership、one active handoff、double tap、external failure、expiry、resume/report/cancel、OFF drain、paper fallback、staff前誤完了なしを確認する。

- [x] **V029-5 電子処方箋の薬局管理画面と安全なendpoint診断**
  - 既存`/myna`のroute/file名は変えず、表示labelを「電子処方箋受付」へ明確化する。filter、患者、申告時刻、期限、verification、`shadow_submission_id`から既存処方箋detailへのlinkを追加する。
  - authorized same-account staff verificationだけが、受領state、shadow submission、auditを一つのatomic boundaryで作成する。二重verificationは同一結果へ収束する。
  - network probeはMyna側にpatient-free・credential-free・side-effect-freeな文書化contractがある場合だけ実行する。契約がなければURL scheme/host allowlistのlocal validationだけを行い`UNVERIFIED`とする。
  - probe時はuserinfo/redirect拒否、DNS解決後IPv4/IPv6 private/local拒否、短いtimeout、response body非取得、固定error、credential/log非露出を満たす。2xx/401/405/TCP到達だけで業務endpoint verifiedとしない。
  - **Red -> Green**: staff/account guard、patient/staff境界、idempotent shadow submission、probe zero-call/SSRF matrix、成功時だけevidence更新を確認する。

- [x] **V029-6 緊急避妊薬の薬局管理画面を先にqueue/detail化**
  - 設定・薬剤師・在庫・枠・受付を「受付キュー」「対応枠・在庫」「研修修了薬剤師」「公開設定」へ分ける。account-scoped bounded paginationとstatus/slot/deadline filterを使う。
  - 一覧はreference、operational status、slot、deadlineだけを返す。暗号化申告、性交日時、patient identity、risk flag、verification noteを返さずdecrypt関数を呼ばない。
  - detail APIはtenant/account/intake ownership、staff role、現在有効な研修修了状態を一つのserver-side access pathで確認し、sensitive read audit成功後にだけ最小申告を復号する。audit失敗は固定503でfail closedする。
  - status/在庫/枠更新は既存CAS・確認dialog・auditを再利用し、新しい適格性statusや販売結果を作らない。
  - **Red -> Green**: list decrypt 0回、list field allowlist、detail trained/account/role/audit、別account、cursor/filter、race後再取得、keyboard/狭幅を確認する。

- [x] **V029-7 緊急避妊薬status cardとstaff-triggered中立通知**
  - 患者LIFFで状態、対応枠、受付期限、server-computed expiry、取消可否、次の行動を一枚にまとめる。client clockは表示だけに使い、状態変更authorityにしない。
  - 自動LINE送信は明示staff status transition、active same-account intake、`safe_contact_mode='neutral_line'`、承認済み固定templateの全条件を満たす場合だけ許可する。null/unknown/`no_notification`/`phone`/`none`は送信しない。
  - status更新とnotification intentは既存atomic idempotency/outbox経路を再利用する。条件を満たす既存経路がなければv0.29.0はstatus cardだけ実装し、通知を延期する。
  - delivery失敗はintake、slot、在庫を変更せず、同じtenant/account/intake/status revision/templateは一つのidempotency keyへ収束する。時刻起点reminderは実装しない。
  - **release boundary**: v0.29.0の必須範囲はstatus cardまでとする。既存の安全なoutbox/idempotency経路を再利用できない場合、staff-triggered通知はV030-4の前提sliceへ送り、V029-13のHuman Gate・完了条件へ含めない。
  - **Red -> Green**: server time、owner status/cancel、CAS reload、contact mode、exact template、duplicate、delivery failure、PHI-free payload/logを確認する。

- [x] **V029-8 LIFF全機能一覧をaccount設定へ連動**
  - public `GET /api/liff/config`はserver-side LIFF account解決を再利用し、non-PHI `enabledFeatures`とcapability revisionだけを返す。0件または複数accountへ解決されるLIFF IDはfail closedし、`Cache-Control: no-store`とする。
  - public responseへpatient history、active record、friend/patient IDを含めない。受付状況とOFF前active recordのdrain導線は、認証済みpatient/account ownership projectionから追加する。
  - v0.29.0の表示順はserver allowlistの固定順にし、account別layoutは導入しない。static routeとlegacy page keyを維持する。
  - disabled direct routeは中立的な利用不可説明と戻る導線を表示し、mutationはV029-3のserver guardで409拒否する。
  - **Red -> Green**: unique LIFF resolution、no-store、public/auth分離、ONのみ表示、全OFF、active drain、direct disabled、別account、`liffId`非authorityを確認する。

- [x] **V029-9 canonical非PHI readiness projectionを作る**
  - readiness実装は一つのaccount projectionへ集約し、薬局管理画面、platform-admin、`line-status`、CLIが同じ結果を利用する。各surfaceで独自SQL/判定を作らない。
  - 電子処方箋はcapability、endpoint configured/evidence status/checked_at、緊急避妊薬はcapability、trained pharmacist/inventory/future slotのboolean readinessを返す。
  - active handoff/intake/open slotの件数、patient/friend ID、reference、risk、verification note、復号値、credential materialを返さない。
  - 外部証拠は`status`、`source`、`checked_at`、freshness policyを持ち、local DBだけでupstream `READY`と判定しない。audit失敗はfail closedする。
  - **Red -> Green**: surface parity、0件状態、stale evidence、別tenant、payload field allowlist、PHI/credential/count非露出を確認する。

- [x] **V029-10 platform adminのrich-menu prepare入口を明示的に閉じる**
  - platform-admin bearer/tenant settings contextから`/api/custom/pharmacy/rich-menus/prepare`を実行できる経路を追加しない。middlewareが通している場合はaccount data取得やLINE APIより前に固定403となるよう入口契約を揃える。
  - rich-menu prepareは既存tenant owner/staff assignmentと`pharmacy_rich_menu` capabilityを維持する。platform adminはV029-9の非PHI readiness readだけを利用できる。
  - PHI route allowlist、capability mutation、rich-menu prepare/publish/default authorityをplatform adminへ拡張しない。
  - **zero-call scope**: `LINE call 0件`はconfig保存、LIFF config、health、preflight、canonical readiness、platform-admin、cron、V029で追加するbackground pathを対象とする。既存owner/staff rich-menu mutation routeをV029で拡張、自動実行、新lifecycle化しない。
  - **Red -> Green**: platform admin 403 + LINE call 0件、別tenant 404、通常staff未割当403、owner既存契約不変を確認する。

- [x] **V029-11 `line-status`と`tenant:settings --preflight`をread-only拡張**
  - V029-9のcanonical projectionを既存`GET /api/platform-admin/tenants/:id/line-status`とCLIへ投影する。domain readiness SQLを重複実装しない。
  - LIFF ID、LINE Login、Messaging/Login credential coverage、期待Endpoint URL、電子処方箋/緊急避妊薬readinessを`READY`/`BLOCKED`/`UNVERIFIED`で表示する。secret名・値・復号結果は返さない。
  - v0.29.0では新しい6-slot/image/draft revision判定を追加しない。既存menuの存在と、preflightがLINE mutation 0件であることだけを確認する。
  - CLI `--preflight --account-id`は`--apply`と併用不可、nonzero exitは対象account activationを止める。任意platform-admin pathを通す汎用CLIにしない。
  - **Red -> Green**: projection parity、credential欠落、Endpoint `UNVERIFIED`、別tenant、secret非表示、network/JSON error、`--apply`拒否、LINE call 0件を確認する。

- [x] **V029-12 focused Green後の最終code refactor**
  - 各phaseをRed -> Green -> Refactorで完了し、最後にcapability guard、operation matrix、readiness projection、固定feature metadataの重複だけを、全callerが通る既存shared関数へ寄せる。
  - folder/file/public route/DB tableをrenameせず、dependency追加、全体format、汎用framework、将来用interfaceを作らない。一度しか使わないwrapperと到達不能な旧branchはfocused test後に削除する。
  - `apps/liff`、`apps/web`、`apps/worker`、`packages/db`の薬局custom seam一覧と依存図はread-only evidenceとして作り、移動候補は次版backlogへ送る。
  - **完了条件**: behavior不変、旧internal branch/reference 0件、focused tests再green、diffがsecurity-sensitiveな変更を追跡可能な大きさに保たれる。

- [ ] **V029-13 focused regression・dev受入・release準備**
  - R1 previous reader、R2 migration、R3 capability write、R4 disable/create race、R5 drain matrix、R6 cron/notification isolation、R7/R8 Myna ownershipとpatient/staff境界、R9 endpoint probe、R10/R11 EC privacy/status、R12/R13 LIFF public/auth/drain、R14 readiness parity、R15 platform-admin/zero-LINE-callを必須contract suiteとする。
  - focused tests、薬局custom seam回帰、typecheck、build、migration fixture、static route/deep-linkをgreenにする。既存未コミット作業を混入させずexact-path commitする。
  - dev deploy後にPages asset marker/Worker API/CORS、canonical readiness、LINE Endpointの自動またはmanual evidenceを別々に記録する。
  - Human Gateで実LINE端末のMyna外部遷移/復帰/紙fallback、機能ON/OFF/全OFF、active drain、disabled旧rich-menu tap、緊急避妊薬status、V029-7へ通知を同梱した場合だけ承認済み中立通知、薬局情報/FAX、右上versionを確認する。
  - package `0.29.0`、詳細`CHANGELOG.md`、seller tag `pharmacy-v0.29.0`は明示指示により準備する。GitHub Release本文、dev push/main merge/deploy/activation/LINE mutationは個別の明示指示を受ける。
  - **Oracle evidence**: session `pharmacy-v029-full-plan-review`、`requestedKey=gpt-5.6-sol`、`resolvedLabel=GPT-5.6 Sol`、`verified=yes`、`thinkingTime=pro`、transcript validation `ok`。判定`CHANGE`を上記順序・権限縮小・延期へ反映済み。
  - **v0.29.0完了条件**: previous-version互換、atomic admission/drain、Myna patient/staff境界、EC detail decrypt、LIFF public/auth分離、platform-admin read-only、上記zero-call対象pathがgreen。未説明の`BLOCKED`なし。`UNVERIFIED` accountはactivationしない。

#### 2026-08-21 実装レビュー・refactor証跡

- V029-0〜V029-12のローカル実装を完了。V029-13はlocal regression/build/migration fixtureまで確認し、dev deploy、実LINE端末、Console manual evidence、schema apply、activation、push/merge/tag/releaseは未実施のHuman Gateとして残す。
- 追加レビューで、処方せん画面内tabのfeature gate迂回、緊急避妊薬queueのfilter/pagination不足、無効staff assignmentを含む枠公開・受付、旧`is_enabled`からowner-only capabilityへの逆流、manual evidence日時の誤帰属、任意Myna status、migration safety parser非適合を検出し、各Red test後に共通境界で修正した。
- 実装後Oracle review `pharmacy-v029-implementa-review`（GPT-5.6 Sol / Pro / `verified=yes`）のHigh 3・Medium 7・Low 2を再現性と版境界で照合した。Myna verification replay、terminal lifecycle、account切替race、整数capability revision、EC readiness/期限切れhold、reminder最終claim、manual chat送信直前再確認、active件数、queue表示契約を修正。既存owner向けrich-menu mutationはV029で権限拡張していないため現行契約を維持した。
- refactorは、処方せん表示状態をURLへ一本化、Myna handoff status allowlistを型とroute validationで共有、Myna患者操作を状態遷移表へ集約、LIFF設定取得を画面内で共通化、`CASE` triggerを単一責務の条件triggerへ分割した。新規dependency、汎用flag framework、route/table/folder/file renameは追加していない。
- local gate: LIFF `18 files / 75 tests`、Web `35 / 170`、Worker `193 / 1802`、DB `59 / 311`、scripts `15 / 139`、workspace typecheck、LIFF/Web build、migration safety `75 migrations`、bootstrap fixtureがgreen。Web buildは秘密情報を使わず`NEXT_PUBLIC_API_URL=https://worker.example`で静的生成契約だけを検証した。
- 薬局custom seamと依存方向は次のread-only inventoryを正とし、実移動はV030へ送る。

```text
apps/liff/src/custom/pharmacy
  -> public LIFF config + authenticated drain projection
  -> feature gate
  -> prescription / emergency contraception patient flows
apps/web/src/custom/pharmacy
  -> selected account context
  -> admin API clients
  -> Worker account-scoped routes
apps/worker/src/custom/pharmacy
  -> auth + account authorization
  -> capability access + canonical readiness
  -> domain repositories
packages/db
  -> schema + custom_NNN additive migrations
  -> generated bootstrap artifacts
```

### V030 - 可変rich menu・scheduled reminder・repository保守性改善 - 0.30.0実装予定

**位置付け**: seller release `pharmacy-v0.30.0`として実装予定。v0.29.0から明示延期したaccount別rich menu配置・画像・LINE同期、owner確認付き初期設定の実稼働、緊急避妊薬の時刻起点reminder、repository seam inventoryと条件付きfolder/file整理を対象とする。v0.29.0のatomic capability/drain、authenticated LIFF projection、canonical readiness、platform-admin read-only、zero-LINE-call contractがgreenになるまでは着手しない。

**目的**: 薬局ownerが有効機能の範囲内でrich menuの配置を変更し、画像とtap actionを同じimmutable draftへ束縛して、安全なHuman GateでLINEへ反映できるようにする。画像はrequest時やbrowser内で生成せず、release時に生成・検証した完成画像catalogからserverが一致するvariantを選ぶ。画像とactionを束縛したmenu versionをaccountごとに複数保存し、管理画面またはtenant/account固定CLIからpreview・切替・rollbackできるようにする。新規薬局の初期設定はlocal draft作成だけで終わらせず、LINE candidate作成・画像upload・初期表示設定・read-back確認まで再開可能な案内付きflowとして稼働させる。初期presetでは現行の「緊急避妊薬」枠を「処方せん送信」へ置き換える。緊急避妊薬は「すべての機能」から到達可能に保ち、v0.29.0のstaff-triggered中立通知を土台に時刻起点reminderを追加する。repositoryは機能実装と回帰完了後にseam inventoryを作り、実移動は具体的な欠陥と別承認がある場合だけ行う。

**非目標**: request時・browser・Workerでのrich-menu画像リアルタイム生成、画像だけをactionから分離して切り替える操作、任意URL/message/imageを許す汎用builder、CLIからの直接DB更新・任意外部URL request・認証迂回、patient/friend/chat/PHIのraw CLI出力、platform adminからのLINE mutation、アカウント登録直後の無確認LINE mutation、config保存/health/preflight/cronによるmenu mutation、AI画像生成、患者情報を含むmenu/notification、販売可否自動判定、公開API/DB tableの破壊的rename、全repo一括移動。

**Oracle再レビュー反映**:

| 判断 | 0.30.0での扱い |
|---|---|
| `KEEP` | v0.29.0を安全基盤、v0.30.0をLINE外部mutation・時刻起点notificationの版とする分割 |
| `CHANGE` | editing stateとimmutable draftを分離し、server-derived manifestとexact image bytesを束縛 |
| `CHANGE` | local prepare、LINE create/upload、set-default、explicit rollbackを別gate化 |
| `CHANGE` | reminderを独立activationとし、安定したoccurrence key・timezone・catch-up policyを固定 |
| `DEFER` | 実際のfolder/file moveは既定で先送りし、v0.30.0必須範囲はseam inventoryまで |
| `DEFER` | 未使用のper-user link/unlink/bulk、自動remote menu削除、複数reminder、自由文通知 |

**初期設定preset `initial-large-3x2-v4`**:

| 位置 | 表示 | action |
|---|---|---|
| 左上（現行の緊急避妊薬枠） | 処方せん送信 | `pharmacy-prescription-send` LIFF link |
| 上中央 | 受付状況 | `pharmacy-prescription-history` LIFF link |
| 右上 | 服薬後フォロー | `pharmacy-followup` LIFF link |
| 左下 | 薬局へ相談 | server-owned固定message |
| 下中央 | 薬局情報 | `pharmacy-info` LIFF link |
| 右下 | すべての機能 | `pharmacy-menu` LIFF link |

緊急避妊薬は削除せず、accountで`emergency_contraception`がONの場合に「すべての機能」へ表示する。初期presetをLINEへ反映できるのは`pharmacy_rich_menu`と`prescription_intake`がONで、LIFF ID・Messaging API credential・account ownership・画像assetがREADYの場合だけとする。

**並び替え・ON/OFF画像追従方式（リアルタイム生成なし）**:

v0.30.0でrich menuへ直接配置できるtileは、現行v4の5種類（`prescription-send`、`prescription-history`、`medication-followup`、`manual-chat`、`pharmacy-info`）へ限定する。電子処方箋、患者アンケート、継続フォロー、緊急避妊薬など、direct tile対象外の有効機能は固定「すべての機能」から到達可能にする。direct tile追加は画像catalog再生成を伴うため、profile/generator versionを上げるrelease変更として扱う。

| 状態 | 実行すること | 実行しないこと |
|---|---|---|
| ownerが並び順を保存 | account別`preferredOrder`とlayout revisionをCAS保存 | 画像生成、LINE call、公開中menu更新 |
| 機能をON/OFF保存 | `preferredOrder`を保持したまま、current capabilityで`effectiveOrder`をserver-side再導出し、対応catalog variantと公開中との差分を`STALE`表示 | LINE create/upload/default、既存menu削除 |
| 新しい配置を準備 | release済みcatalogから`effectiveOrder`完全一致の完成JPEGを選び、action manifest・catalog hash・各revisionを新immutable draftへ固定 | client画像、部分一致variant、旧confirmation再利用 |
| ownerが反映を確認 | V030-3のcreate/uploadとset-defaultを別gateで実行し、fresh read-back後だけ`CURRENT`へ更新 | config保存を根拠にした自動公開、blind retry |

画像sourceは背景、5種類の承認済みtile、固定「すべての機能」のみにする。release用の決定的generatorが有効tileの順列を完成JPEGへ展開し、`variantKey -> ordered action keys -> menu size -> file -> SHA-256 -> width/height/type/bytes`のcatalog manifestを生成する。合計1〜3枠はCompact `2500x843`、4〜6枠はLarge `2500x1686`を自動選択し、無効tile用の空枠は作らない。現行capability mappingでは全合法ON/OFF状態と任意並び替えは228 variant（Compact 12、Large 216）とする。生成物はversioned R2 prefixへrelease時に一括配置し、runtimeはlookupとhash検証だけを行う。catalog欠落、hash不一致、未知variant、上限超過は`BLOCKED`とし、似た画像へのfallbackは行わない。

`preferredOrder`はOFF中tileも含む5 action keyの全順序を保持する。`effectiveOrder`は`preferredOrder`をcurrent capabilityでfilterした結果で、OFFにしたtileは完成画像とtap areaの両方から外れ、再度ONにすると保存済み位置へ戻る。「すべての機能」は有効tile列の最後に固定し、合計枠数に最適なCompact/Large座標をserver-sideで選ぶ。これにより、画像・size・actionは同じordered action key列から導出され、別accountのlayoutやcapabilityを参照しない。

**複数画像保存・管理画面切替**:

保存単位はraw画像ではなく、既存`rich_menu_groups`、page、areas、account別image R2 keyとv0.30 immutable draft bindingを再利用した`menu version`とする。1 accountに複数のdraft/upload済み/published versionを保持でき、各versionは表示名、Compact/Large、catalog version/variant、画像hash、manifest hash、作成日時、LINE remote ID、current default read-back状態を持つ。画像とaction manifestの組合せは作成後に変更せず、変更は新しいgroup/draft IDとして保存する。operator表示名だけはhash対象外metadataとしてCAS renameできる。

管理画面はthumbnail付きversion一覧、current default、前回known-good、draft、upload済み、`UNVERIFIED`を区別する。ownerは保存済みversionをpreviewして「切替候補にする」ことができるが、画像だけを既存actionへ差し替えない。未upload versionはV030-3のcreate/upload、upload済みversionへの切替はfresh expected defaultとdry-run confirmationを使う`set-default`、戻す操作は同じversion一覧からのexplicit rollbackとして扱う。保存・一覧・previewはLINE call 0件、version削除はdraftかつremote IDなしに限定し、published/known-good/結果不明versionを自動削除しない。

**CLI/API・設定漏れ検知**:

既存`pnpm tenant:settings`（`scripts/custom/pharmacy/manage-tenant-settings.ts`）とMCPのaccount pin・dry-run/confirmation guardを拡張する。新しい重複CLI packageは作らない。CLIは既存`--worker-url`、`--tenant-id`、platform-admin login、追加する`--account-id` pinを使い、全requestを同じconfigured HTTPS originの相対`/api/` pathとserver-side authorizationへ通す。直接D1/R2/LINE APIを操作しない。

| CLI surface | v0.30.0の範囲 | gate |
|---|---|---|
| `tenant:settings --path ...` | feature ON/OFF、薬局情報、電子処方箋、緊急避妊薬readinessを含む非PHI設定API | GETは即時、mutationは既存dry-run・expected revision・`--apply` |
| rich-menu専用option | layout get/set、saved version list/preview/prepare、upload、switch、rollback | account pin、local操作とLINE操作を分離、LINE操作はserver confirmation token |
| `--preflight` / `--doctor` | canonical readiness、local CLI credential有無、API到達、version/config/catalog不足 | PHI-free reason code、secret値非表示、exit code固定 |
| generic `--method/--path` | Admin UIが使う非PHIの設定・readiness・account運用APIをcoverage manifestから呼ぶ | relative path allowlist、mutationは`--apply`、patient/friend/chat/raw exportはdeny |

設定漏れ検知は管理画面・CLI・全体管理画面で同じcanonical readiness projectionを使う。account/tenant mapping、staff assignment、capability row/revision、LIFF ID/endpoint、LINE credential存在・復号可否、rich-menu catalog version/hash、saved version、upload/default/read-back evidence、機能別前提をbooleanと固定reason codeで返す。secret名/値、credential、remote token、patient/friend ID、case countは返さない。CLI `doctor`はlocal envの「存在」だけを追加し、`READY=0`、設定不足`BLOCKED=2`、API/認証不能`UNVERIFIED=3`で終了する。config保存・doctor・healthはLINE mutation 0件を維持する。

**画面別アップデート候補**:

| surface | v0.30.0 | v0.31.0へ送るもの |
|---|---|---|
| 患者LIFF | 共通薬局header、全機能へ戻る導線、version、再試行、既存利用中badge | owner-scoped対応タイムラインと次の行動 |
| 薬局管理画面 | account別「本日の対応」read-only summary、deep link、partial failure表示 | domain横断のbounded action queue |
| 全体管理画面 | 非PHI pharmacy readiness集約、LIFF/menu/version evidence | fleet drift、予約切替状態、redacted support snapshot |

- [ ] **V030-0 v0.29.0前提証拠と0.30.0 Red contractを固定**
  - v0.29.0のcapability revision、atomic admission/drain、LIFF public/auth分離、canonical readiness、platform-admin denial、notification outbox/idempotencyのgreen証拠を確認する。
  - frozen v0.29 Worker/reader/dispatcherがv0.30のadditive draft dataと新reminder kindを安全に無視し、LINE mutation・通知送信を行わないことを固定する。greenにできなければ先行expand releaseまたはrollback中のmutation/send freezeを必須にする。
  - V029-7がstatus cardだけで完了した場合は、既存方式を再利用したstaff-triggered通知contractをschedulerより先に独立sliceでgreenにする。最初のdelivery pathと時刻schedulerを同時導入しない。
  - 現行repositoryでper-user rich-menu link/unlink/bulkを使うか、account-scoped activation controlが存在するかを証拠化する。未使用のper-user操作は対象外とし、activation controlがなければ新挙動をdormantに保つ。
  - 現行`initial-large-3x2-v3`の左上が緊急避妊薬で、アカウント登録flowはlocal draft prepareまでしか行わない事実をfixtureで固定する。既存published/default identity、R2 image ownership、tenant owner/staff assignment、旧menu rollback候補も同じfixtureで記録する。
  - stale capability/layout/LIFF revision、cross-tenant/account、画像/action差替え、confirmation再利用、LINE partial failure、reminder二重実行をRed testで再現する。rename後旧importはV030-5のmoveが別承認された場合だけ対象にする。
  - **受入条件**: v0.30.0のbase commit、対象account、外部mutation境界、rollback対象、前提testが追跡できる。
  - **進捗(2026-08-21)**: base seller tagは`pharmacy-v0.29.0` / `554d750d3b2bc67b8da76e61207f90b712df3056`。capability互換、atomic outbox/idempotency、inactive/frozen account control、legacy mutation bypass拒否、v3 rollback profile、additive schemaをfocused testで確認した。synthetic対象account、実v0.29 binary rollback、remote current/known-good identityは外部受入時に固定するため未完了。

- [x] **V030-1 初期preset・account別menu layout・immutable draft**
  - 新profile `initial-large-3x2-v4`をrelease catalogの承認済みtile sourceにし、左上画像ラベルを「処方せん送信」へ変更する。現行`v3`は既存published menuのrollback証跡として変更・削除しない。
  - 従来の全体画像を一括作成する`POST /api/custom/pharmacy/rich-menus/prepare`は`410 Gone`へ固定し、Web/SDK/MCPの呼び出し口も廃止する。新規初期設定はaccount別layoutから保存済みversionを作成する経路へ一本化し、既存published/default menuを暗黙更新しない。
  - 固定「すべての機能」枠を予約し、release catalogに含まれる5 direct tileだけをownerが任意に並べ替える。direct slotに出ない有効機能は必ず全機能画面から到達可能にする。
  - capabilityはauthorization、layoutはpresentationとして分離する。account-scoped additive schemaにはOFF中tileを含む5 keyの`preferredOrder`とlayout revisionだけをCAS保存し、`effectiveOrder`はcurrent capabilityから毎回server-side導出する。capability revisionとLIFF config revisionをclient値から保存しない。
  - 編集中layout、preview、未保存状態をimmutable draftと呼ばない。serverがcurrent revisionsを再取得し、固定allowlist metadataからcanonical action manifestを生成し、exact image bytesのSHA-256を計算し、release-generatedかつ同一key上書き不可のR2 catalog objectを確認した後に一度だけdraftを作る。
  - request時の画像生成を行わない。release用generatorが全合法variantを事前生成し、Compact `2500x843`またはLarge `2500x1686`、JPEG、LINE上限内、variant数228、manifest/action/image/size一致、SHA-256をtestで固定してversioned R2 catalogへ配置する。runtimeは`effectiveOrder`完全一致のcatalog entryを選ぶだけにする。
  - client-supplied URL/action/image bytes/hash/object key/variant key/LINE richMenuIdをauthorityにしない。draft row・manifest・hash・object bindingの更新APIは作らず、変更は新draft IDにする。catalog objectはrelease単位でimmutableとし、欠落・hash不一致時はpublish不可、GCはrelease条件にしない。
  - additive schemaはmixed-version safeとし、code deploy時点ではdraft 0件・新mutation path inactiveにする。code rollbackのためのdown migrationやremote LINE変更を要求しない。
  - effective slotsはstored allowlistとcurrent enabled capabilitiesの積集合とし、capability変更後の旧draftをprepare/create/upload/set-defaultできない。
  - **Red -> Green**: `v4`の1〜6枠adaptive座標・label/action/image/size一致、処方せん送信link、旧profile互換、5 key全順序、OFF filter/ON復帰、fixed fallback、catalog 228 variant、Compact 12/Large 216、catalog manifest/hash/dimension/type/size、重複/未知/disabled/6件目拒否、stale revision、cross-account、immutable hash/objectを確認する。
  - **完了(2026-08-21)**: v4 source、228 variant generator、account別CAS layout、server-derived immutable version、旧prepare 410、runtime exact lookup、hash/寸法/type/1MB/50MB検証をgreen化した。deploy workflowは既存manifestと各画像byteを比較し、同一keyの異なる内容を上書きせずversion bumpを要求する。development R2 `harness-test-pharmacy-images-dev/rich-menu-catalog/v4-2/`へ228 JPEGとmanifestを登録し、remote manifest SHA-256 `f40013149258636e4fd8e9d83f51576a8e687c4340afd2531f35c0abf37374f7`、全228画像のbyte/hash/size一致をread-back確認した。production R2は変更していない。

- [x] **V030-1A account別saved menu version・複数画像保持**
  - 既存`rich_menu_groups/pages/areas`とgroup/page別R2 keyを再利用し、1 accountに複数のimmutable menu versionを保存する。初期presetのgenerator keyはidempotentに1件を維持し、owner保存versionは新group IDとして加算する。
  - list/detail responseはaccount、表示名、catalog version/variant、image/manifest hash、draft/upload/published/current/known-good/`UNVERIFIED`、created/updated evidenceだけに限定する。image bytes、arbitrary URL、credential、patient/friend identifierをJSONへ含めない。
  - version作成時にserver-derived action manifestとcatalog JPEG hashを同時に固定し、既存versionのpage/area/image bindingを更新しない。renameはexpected metadata revision、deleteはdraftかつremote IDなし・current/known-good以外だけ許可する。
  - **Red -> Green**: same-account複数version、同一variant再保存、別account非表示、image/action hash binding、rename CAS、published/current/known-good/`UNVERIFIED`削除拒否、R2 key分離を確認する。
  - **完了(2026-08-21)**: 保存versionの作成・account別一覧・複数保持・immutable binding、`updated_at`を再利用したrename/delete CASをgreen化した。deleteはdraft・remote IDなし・current/known-good/`UNVERIFIED`以外だけをatomicに許可し、generic `force=true`からの迂回も拒否する。known-good/`UNVERIFIED`はV030-3のaccount-scoped operation evidenceから導出し、管理画面へ表示する。

- [ ] **V030-2 薬局管理画面の配置編集・画像/action preview**
  - アカウント登録完了画面とrich-menu管理画面に「初期設定を開始/再開」を表示する。`READY`でない項目は不足理由と修正導線を示し、準備済み・LINE登録済み・画像upload済み・初期表示済み・`UNVERIFIED`を一つの「完了」に丸めない。
  - 初期設定flowはownerが各外部mutationを確認し、途中失敗後は保存済みoperation stateから安全に再開できるようにする。画面を閉じてもremote menuを作り直さず、結果不明時は自動retryしない。
  - owner向けに5項目の並べ替えと最後の固定fallbackを表示し、dragだけでなく上下左右buttonとkeyboardで操作できるようにする。薬局accountでは従来のraw全体画像作成・編集UIを表示せず、保存versionの作成・LINE登録・切替へ一本化する。44px target、狭幅、未保存変更、account切替を扱う。
  - LINE対応のCompact/Large座標とrelease catalogのallowlist label/iconを再利用する。browser Canvas、Worker renderer、client uploadは作らず、editing stateの`effectiveOrder`に一致するcatalog JPEGをpreviewする。
  - previewはcatalogのexact image bytesとserver-derived tap overlayを重ね、draft ID、catalog version/variant/hash、server-derived manifest hashを一つのconfirmationへ束縛する。catalogまたはmanifest変更時は新draft・新confirmationを要求し、generic editorの任意URL/message/image authorityを公開しない。
  - 44px targetとkeyboard操作に加え、programmatic name/position/state、reorder後のfocus、保存・CAS conflict・validation errorのscreen-reader通知を備え、drag・色・位置だけへ依存しない。
  - **Red -> Green**: 初期設定のREADY/BLOCKED/UNVERIFIED表示と再開、layout操作、accessibility、画像寸法/type/size、draft freeze後のbyte/hash/object mismatch、未confirm upload、preview overlay、別accountを確認する。
  - **進捗(2026-08-21)**: アカウント登録・連携後にcanonical readinessを取得し、`READY`/`BLOCKED`/`UNVERIFIED`を「初期設定を確認/開始/再開」と不足項目の修正導線へ反映した。rich-menu管理画面にも同じ状態表示と配置editorへの導線を追加し、機能OFF時は設定画面へ案内する。Web薬局custom seam 28 files / 127 testsがgreen。development R2への全variant登録・read-backは完了。実ブラウザの狭幅・200% zoomと実LINE lifecycleは外部受入のため未完了。

- [x] **V030-2A 公開中menuとdraftの差分表示**
  - fresh read-back済みのcurrent default manifestとimmutable draftをslot単位で比較し、`同一`、`追加`、`削除`、`移動`、`action変更`、`画像変更`を表示する。remote evidenceが古い場合は「公開中」と断定せず`UNVERIFIED`とする。
  - diff APIはserver-owned manifest、image hash、account/revisionだけを扱い、patient/friend identifier、credential、raw arbitrary URLを返さない。clientが送ったcurrent stateを比較元にしない。
  - **Red -> Green**: slot差分全種、fresh/stale evidence、same hash、cross-account、PHI/credential非露出、keyboard/screen-reader表示を確認する。
  - **完了(2026-08-21)**: current defaultの24時間以内のread-back evidenceと保存済みserver-owned manifest/image hashだけを比較し、6種類のslot差分と`UNVERIFIED`をAPI・薬局管理画面へ表示した。cross-accountを拒否し、raw URL・credential・patient/friend identifierをresponseへ含めないcontractをgreen化した。

- [x] **V030-2B 機能ON/OFF後のrich-menu同期アシスト**
  - capability保存自体はLINE call 0件を維持し、current capabilityで`effectiveOrder`とcatalog variantを即時再導出する。published/draft capability revisionとの不一致をcanonical readinessへ`STALE`として反映し、OFF機能が公開menu画像/actionに残る場合と、ON機能がdirect slot対象外または公開menuに未反映の場合を別メッセージで示す。
  - 機能設定保存後は「リッチメニュー候補画像を確認」を表示し、対応する事前生成JPEGと削除・復帰・移動するtap actionをpreviewする。「新しい配置を作成」はcurrent allowlist、capability、`preferredOrder`、catalogからediting stateを作るだけとし、prepare/create/upload/set-defaultはV030-3のconfirmationを省略しない。既存published menuを自動更新・削除しない。
  - OFF中tileを`preferredOrder`から削除しない。再ON時は以前の位置へ復帰し、ownerが並べ替えて保存した場合だけlayout revisionを増やす。全direct機能OFF時は「すべての機能」だけのCompact variantを使う。
  - **Red -> Green**: ON/OFF双方、OFF画像/action同時除去、ON時の保存位置復帰、全OFF variant、active drain、stale revision、catalog欠落/hash不一致、保存時LINE zero-call、別account非影響、明示publish/read-back後のfresh化を確認する。
  - **完了(2026-08-21)**: capability保存をrepository-onlyのまま維持し、current capabilityと保存済み`preferredOrder`から候補variant、exact JPEG、tap overlay、`CURRENT`/`STALE`/`UNVERIFIED`をGET-onlyで再導出した。OFF削除・ON追加・移動を別メッセージで示し、all-off Compact、revision/hash binding、catalog fail-closed、cross-account拒否、LINE call 0件をgreen化した。

- [x] **V030-2C tap link事前診断**
  - server-derived action manifestの全枠について、LINE action type、LIFF host、accountのLIFF ID、allowlist page key、route解決、`liffId`保持、必要capability、固定「すべての機能」枠をlocal/read-onlyで検証する。
  - 診断は任意URLへのnetwork probeやpatient sessionを使わず、公開前のcreate/upload/set-default gateで`BLOCKED`を返す。message actionは承認済み固定文言との完全一致を確認する。
  - **Red -> Green**: `v4`全adaptive枠、未知page/host、欠落・別LIFF ID、disabled action、固定message改変、all-functions欠落、LINE call 0件を確認する。
  - **完了(2026-08-21)**: 228 variantのserver-derived manifestを全件診断し、枠数・座標・action type・LIFF URL・固定messageの不一致をreason code化した。hashごと誤設定された未知host/page、別LIFF ID、disabled action、all-functions欠落もpublish/set-default readinessで`BLOCKED`となり、LINE credential・lock・API call前に停止する。管理画面はaction診断reasonを日本語で表示する。Worker 69件、LIFF route 5件、Web 3件がgreen。

- [ ] **V030-2D 保存済み画像version一覧・管理画面切替**
  - rich-menu管理画面へthumbnail付きsaved version一覧を追加し、current default、known-good、draft、upload済み、published、`UNVERIFIED`をbadgeと説明で区別する。account切替時は旧responseを破棄する。
  - previewは保存済みexact JPEGとserver-derived tap overlayを表示する。「この画像へ切替」は画像単体置換ではなく、versionのremote richMenuIdをV030-3 set-default候補へ渡す。未uploadならcreate/upload flowへ案内し、結果不明時は自動retryしない。
  - version rename/delete、切替、rollbackは別操作とする。44px target、keyboard、狭幅、200% zoom、screen-reader statusを備える。
  - **Red -> Green**: 複数thumbnail、current/known-good表示、preview action一致、未upload導線、switch dry-run/confirmation、cross-account、account switch race、保護version delete拒否を確認する。
  - **進捗(2026-08-21)**: thumbnail一覧、current/known-good/`UNVERIFIED`表示、account switch race防止、rename、安全なdraft削除、未upload時のLINE登録導線、switch/explicit rollback導線をgreen化した。`UNVERIFIED` publishは「状態を再確認」でGET-only照合し、安全に不足段階を特定できた場合だけHuman Gate付き「登録を再開」を表示する。保存済みexact JPEGとserver-derived tap overlay preview、LINEのcompact `2500x843`とlarge `2500x1686`を含む全228 variantのlocal release artifact・hash/寸法/1MB上限を検証した。保存画像・group一覧/詳細/作成/編集/公開系は、queryやR2 keyをauthorityにせずserver-side tenant/account lookupを必須化した。development R2への全variant登録・read-backは完了。200% zoomの実ブラウザ確認と実LINE切替は未完了。

- [ ] **V030-3 local prepare・LINE create/upload・set-default・rollbackを分離**
  - 初期設定を「稼働済み」と判定する条件は、`v4` draft作成、LINE candidate作成、exact image upload、account-wide default設定、fresh read-back一致の全完了とする。local draftだけを「初期設定完了」と表示しない。
  - 保存済みversion作成はlocal-onlyとし、tenant/account/current revisions、immutable draft、exact preview confirmationを検証して期限付きoperation confirmationを発行する。旧全体画像`prepare` APIは利用しない。LINE callは0件とする。
  - `create/upload`は一つの明示LINE mutation gateとする。最初のLINE call前にlocal intentを保存し、remote richMenuIdは次のexternal call前に保存する。draftへhash-bindしたrelease catalogのexact JPEGだけをuploadし、結果不明時は`UNVERIFIED`で停止してblind retryしない。
  - account-wide反映は独立した`set-default`とする。fresh remote default、expected current default、target remote ID、draft/current revisionsを確認し、成功後のread-back一致でだけverified evidenceを更新する。per-user操作はV030-0で現行必須と確認された場合だけ別gateとして計画する。
  - rollbackはprevious known-good remote IDをfresh expected stateと新confirmationでdefaultへ戻す独立mutationとする。code/schema rollbackやaccount deactivationから推論せず、旧menuを自動clear/deleteしない。
  - 新lifecycle activation後、既存rich-menu mutation routeは同じlifecycleへdelegateするか最初のLINE call前に固定409とし、迂回路を残さない。v0.29へcode rollbackする前に新lifecycle/reminderをdeactivateしてmutationをfreezeし、remote defaultは維持する。
  - canonical readinessへdraft freshness、upload evidence、current/expected default一致、checked_at、`UNVERIFIED`を集約する。config保存、health、preflight、cronはLINE mutation・暗黙refreshを行わない。
  - **Red -> Green**: 初期設定happy pathと各段階からのresume、local prepare zero-call、client remote ID/credential拒否、create/upload/defaultの結果不明、read-back不一致、confirmation再利用、legacy bypass、cross-account remote ID、code rollback freeze、explicit rollbackを確認する。
  - **進捗(2026-08-21)**: additive `custom_046`へaccount-scoped operationとpublish phase（intent、remote作成、画像upload、alias作成、D1確定）を保存し、順不同の進行とphase evidenceなしの成功をDB制約で拒否した。通常publishは各LINE call後にphaseを永続化し、結果不明時はremote menu list・画像bytes・alias targetをGET-onlyで照合する。安全に不足段階を特定できた場合だけ、期限付きresume confirmationを一度消費してcreate/image/aliasの1段階を実行し、read-back一致後に進める。`set-default`/`rollback`もfresh current defaultでreconcileし、全confirmation再利用をDBで拒否する。管理画面の再確認・Human Gate付きresumeまでgreen。account lifecycleはdefault `inactive`、明示`active`後はlegacy publish/unpublish/default-clear/bulk/orphan-deleteを最初のLINE call前に409、`frozen`では新publish/resume/set-defaultも409とし、GET-only reconcileは維持した。実v0.29 binaryへのrollback drillと初期設定end-to-end実証は未完了。

- [x] **V030-4 緊急避妊薬の時刻起点中立reminder**
  - rich menuとは独立したaccount activation sliceとし、v0.29.0のstaff-triggered通知と既存outbox/idempotencyを再利用する。V029-7がstatus cardのみならV030-0の通知baselineを先にgreenにし、新しいscheduler frameworkは作らない。
  - v0.30は承認済みの1 reminder kindに限定し、既存server-owned anchor、offset、account timezone（未設定時`Asia/Tokyo`）、quiet hours、late/catch-up policyを実装前に固定する。quiet hours後もactionableかつdeadline前だけ延期し、期限後はsuppressする。
  - unique occurrence keyはtenant/account/intake/reminder kind/anchor timestampまたは既存schedule revisionへ束縛し、無関係なstatus/template revisionをdedupe dimensionにしない。atomic insert/claimで同時cron・retry・replayを一件へ収束させる。
  - deploy時は全accountでgeneration OFFとし、既存account-scoped activationで明示ONにする。activation mechanismがなければdormantのまま`BLOCKED`とする。dispatch直前にcapability、contact mode、intake state、anchor、deadline、approved templateを再確認する。
  - 薬名、性交、妊娠、年齢、reference、患者名、詳細時刻を本文/log/analyticsへ含めない。OFF/cancel/expire/complete後は送らない。
  - raw outbox/idempotency keyもlog/analyticsへ出さず、失敗はintake/slot/inventoryを変更しない。1 accountの失敗で他account batchを止めない。
  - **Red -> Green**: concurrent scheduler、unrelated status change後の非再送、anchor変更、quiet-hours延期、deadline後suppress、disable/cancel race、rollback時pending無効化、frozen v0.29 zero-send、PHI-free、multi-account isolationを確認する。
  - **完了(2026-08-21)**: `appointment_neutral_v1`をaccount別default inactiveで実装し、1時間前・`Asia/Tokyo`・8:00〜21:00・deadline前だけの延期を固定した。anchor起点occurrence、atomic claim、dispatch直前のactivation/capability/contact/intake/deadline再確認、frozen時zero-send、PHI-free固定文面、別account継続をgreen化した。activation/deployは別Human Gateのまま。

- [x] **V030-L1 LIFF共通shell・利用中表示・失敗回復**
  - 現行各薬局pageへ、薬局名、画面名、`v0.30.0` package version、固定「すべての機能へ戻る」を同じ位置に出す共通shellを追加する。`liffId`保持には既存`pharmacyRoute()`を再利用し、generic LIFF pageへ広げない。
  - 「すべての機能」は既存authenticated `existingFeatures`だけを使ってOFF後も履歴がある機能へ「利用中」badgeを表示する。件数、患者名、処方内容、緊急避妊薬申告、薬名、期限をpublic configへ追加しない。
  - feature config/history取得失敗時は、LINEから開き直す案内だけでなく同じ画面内の明示「再試行」を提供する。自動無限retry、localStorageへの医療form保存、新しいoffline frameworkは作らない。
  - loading/error/disabled/empty/successのheading、`role=status|alert`、focus移動、44px actionを全薬局pageで揃える。機能OFFでも既存recordのdrain routeを共通shellが隠さない。
  - **Red -> Green**: 全薬局routeのheader/version/back、`liffId`保持、existing badge、config/history partial failure、retry二重実行、disabled drain、390px/200% zoom、keyboardを確認する。
  - **完了(2026-08-21)**: 全7薬局routeを共通shellで包み、薬局名・画面名・package version・`liffId`保持付き「すべての機能へ戻る」を統一した。authenticated `existingFeatures`だけでOFF後の利用中badge/drain導線を維持し、config/historyのpartial failure、単一flight再試行、focus/alert/44px操作をgreen化した。LIFF薬局custom seam 16 files / 69 testsがgreen。実端末の390px/200% zoom確認はV030-6の外部受入へ残す。

- [x] **V030-A1 薬局管理画面のaccount別「本日の対応」summary**
  - 既存の処方せん、電子処方箋handoff、緊急避妊薬queue、患者アンケート、継続/服薬後follow-up、rich-menu readinessを一つのaccount-scoped read-only projectionへ集約し、薬局homeに状態別件数、最終更新、各既存画面へのdeep linkを表示する。
  - summaryは各domainの既存statusを数えるだけとし、新status、共通業務record、横断一括mutationを作らない。緊急避妊薬はqueueと同じ非復号countだけを使い、patient/friend ID、reference、申告、薬名、処方内容を返さない。
  - 1 domain取得失敗で全画面を空にせず、成功部分と失敗部分を分離して表示する。account切替時はrequest世代またはabortで旧account responseを破棄し、表示中account IDをserver query authorityにしない。
  - feature OFF、active drain、rich-menu `STALE`、`BLOCKED`、`UNVERIFIED`を区別し、設定・初期設定・対象queueへ進める。summary画面からLINE mutationや患者status更新を実行しない。
  - **Red -> Green**: same-account counts、別account否定、EC decrypt 0回、partial failure、account switch race、OFF/drain/readiness、deep link、狭幅/keyboardを確認する。
  - **完了(2026-08-21)**: 既存domain statusのaccount-scoped集計だけを使う非PHI summaryを薬局homeへ追加した。EC decrypt 0回、domain別partial failure、account switch race、OFF（利用中）、rich-menu状態、keyboard deep linkをgreen化し、mutationを追加していない。

- [x] **V030-P1 全体管理画面の非PHI pharmacy readiness overview**
  - 既存canonical readinessとruntime/version evidenceを再利用し、全体管理dashboardへtenant/account別`READY`/`BLOCKED`/`UNVERIFIED`件数と更新時刻を追加する。seller release、LIFF package、Web/Worker runtime versionは別fieldで表示し、相互に推測しない。
  - tenant detailのLINE連携へLIFF endpoint evidence、初期rich-menu draft/upload/default/read-back、capability stale、電子処方箋、緊急避妊薬の状態と固定reason codeを表示する。秘密名/値、remote token、patient count、active case countは返さない。
  - platform adminはread-onlyのままとし、feature ON/OFF、rich-menu prepare/create/upload/default/rollback、患者domain mutationへの入口を追加しない。support modeなしの非PHI viewと期限付きPHI support grantを混同しない。
  - **Red -> Green**: canonical parity、version identity分離、stale evidence、reason allowlist、tenant drill-down、PHI/credential/count非露出、platform mutation route 0件を確認する。
  - **完了(2026-08-21)**: dashboardへtenant/account別readiness集約とseller/LIFF/Web/Workerの独立version identityを追加し、tenant detailへcanonical LIFF・rich-menu・機能reasonを表示した。credentialは存在booleanだけ、患者件数・識別子・mutation routeは追加せず、partial readiness failureを`UNVERIFIED`として保持するcontractをgreen化した。

- [x] **V030-C1 既存tenant/account-scoped Admin CLI・API coverage拡張**
  - `scripts/custom/pharmacy/manage-tenant-settings.ts`の既存HTTPS origin、platform session、tenant header、dry-run、rich-menu confirmation flowを再利用する。generic pharmacy requestでも`--account-id`を許可・必須化し、path/query/bodyのaccountと一致しない場合はlogin/request前に拒否する。新しいCLI packageや直接DB clientを作らない。
  - feature設定、薬局情報、電子処方箋、緊急避妊薬readiness、rich-menu layout/saved versions/publish/switch/rollback、canonical readinessを既存optionまたはgeneric method/pathで操作できるようにする。保存versionのLINE登録は`--rich-menu-publish`、初期表示切替は`--rich-menu-default`でserver confirmation tokenを必須にする。既存Admin UIの非PHI設定・account運用APIはcoverage manifestへmethod/path/safe-output/mutation gateを登録する。
  - GET/list/doctorはread-only。PUT/POST/DELETEは既存どおりdry-runまたは差分previewとし、`--apply`、account再確認、expected revisionを要求する。LINE mutationはserver-issued confirmation tokenを省略できない。secret inputは既存のowner-only file、Keychain、environmentまたはinput fileから受け、argv/stdout/stderrへ値を出さない。
  - patient、friend、chat、form submission、prescription/EC payload、raw export、platform-admin mutationはcoverage manifestでdenyする。CLIがserver authorizationやsupport grantを拡張しない。
  - **Red -> Green**: account pin、relative origin、API key非表示、read-only、mutation preview/execute、stale revision、LINE confirmation、safe-output allowlist、denied PHI routes、exit codesを確認する。
  - **完了(2026-08-21)**: 既存`tenant:settings`へaccount pin、generic covered API、doctor、rich-menu publish/default/rollback confirmationを追加した。機能・薬局情報・Myna・EC・layout/versionに加え、本日の対応、active work、候補metadata、公開中diffをread-only coverageへ追加し、PHI route・binary image・任意origin・secret出力は許可していない。CLI 38件がgreen。

- [x] **V030-C2 canonical configuration doctor・漏れ検知**
  - 既存`getPharmacyReadiness`を拡張し、account/tenant/staff/capability、LIFF、LINE credential boolean、catalog、saved/current/default/read-back、電子処方箋、緊急避妊薬のrequired/optional checkと固定reason codeを返す。各surfaceで独自判定を再実装しない。
  - 薬局管理画面は不足項目、影響する機能、修正先deep linkを表示する。全体管理画面は非PHI集約だけ、CLI `doctor`は同じAPI結果とlocal env存在checkを結合する。
  - API/credential/catalog check失敗を「未設定」と断定せず`UNVERIFIED`へ分離する。checkはread-only、bounded、secret/PHI-freeで、config保存・health・cronから修復やLINE mutationを行わない。
  - Admin UI設定API coverage manifestとCLI command/deny理由をtestで比較し、新しい非PHI設定APIがCLI対応または明示DEFERなしで追加された場合を設定漏れとしてfailさせる。
  - **Red -> Green**: required/optional、missing/stale/unreachable、reason allowlist、同一projection parity、secret/PHI非露出、doctor exit 0/2/3、LINE call 0件、coverage漏れを確認する。
  - **完了(2026-08-21)**: canonical doctor、固定reason、required/optional、`BLOCKED`/`UNVERIFIED`、UI/CLI/platform projection、exit 0/2/3、LINE zero-callをgreen化した。admin-facing pharmacy route moduleを実際に列挙し、全routeがCLI coverageまたは`binary-output`/`patient-operation`/`retired`の明示DEFERへ分類されない限りfailする漏れ検知を追加した。

- [x] **V030-C3 設定surface監査で判明した管理画面・CLI漏れの解消**
  - 薬局rich-menu管理画面へaccount lifecycle `inactive|active|frozen`の取得・変更を追加する。既存lifecycle API、owner/admin認可、状態遷移、LINE call 0件を再利用し、公開・default切替とは別操作にする。
  - 電子処方箋設定へendpointの有効/無効操作と、公式画面で確認した時刻を記録する明示操作を追加する。URLを再入力せず停止・再開でき、active endpointの24時間以内の確認証跡だけをcanonical readiness `READY`にする。secret/plain URLは再表示しない。
  - `/staff`へtenant内LINE account別のstaff assignmentを追加し、最低1人の有効staffを失う変更を拒否する。query/bodyのaccountはauthorityにせず、tenant mappingとowner認可をserverで再確認する。
  - CLI coverage testはcustom pharmacy moduleだけでなく、薬局管理画面が使うstaff、LINE account、generic rich-menuの非PHI設定・account運用APIを列挙する。安全なread/mutationはcoverageへ追加し、temporary password、secret入力、legacy lifecycle迂回、破壊操作は固定理由で明示DEFERする。
  - `proactive_monthly_limit`を機能設定画面から0〜100の整数として編集できるようにし、既存Growth config CAS保存を再利用する。
  - **Red -> Green**: lifecycle UI、Myna enabled/verification freshness、assignment cross-tenant/last-staff、CLI全route分類、secret非出力、monthly limit境界を確認する。
  - **完了(2026-08-21)**: rich-menu lifecycle、Myna endpoint有効/無効と確認時刻、staff/account assignment、月間自動通知上限を薬局管理画面へ追加した。CLI coverageはcustom pharmacyに加えてstaff、LINE account、generic rich-menu routeを列挙し、全routeを安全なcoverageまたは固定理由のDEFERへ分類する漏れ検知をgreen化した。

- [x] **V030-P2 全体管理者専用の新規テナントLINE設定ウィザード**
  - `/platform-admin/tenants/new`に、(1)テナント・初期owner、(2)Messaging API、(3)LINE Login/LIFF、(4)確認・登録、(5)結果と残作業、の案内形式を追加する。LINE Developersで値を確認する場所、Webhook URL、LIFF endpoint、必須/任意、秘密値が再表示されないことを各stepで説明する。
  - 既存`POST /api/platform/pharmacy/tenants`の検証、LINE bot確認、AES-GCM credential保存、tenant/account/staff/capability作成、idempotency、Webhook設定を一つのshared provisioning処理として再利用する。新しいDB modelや直接D1書込経路を作らない。
  - browser用endpointは`/api/platform-admin/*`に置き、全体管理者のopaque session、password-change gate、CSRF、no-store、platform auditを必須にする。tenant admin、staff API key、`PLATFORM_ADMIN_KEY`だけのbrowser requestは拒否し、tenant管理画面へ導線を出さない。
  - 登録実行前に入力内容を秘密値を除いて確認し、二重送信は同一idempotency keyで同じ結果へ収束させる。成功後はsecret fieldを破棄し、tenant code、初期owner login ID、Admin URL、Webhook URL、LIFF endpoint、token/Webhook確認状態だけを表示する。rich-menu公開・default設定、production deploy、account activationは自動実行しない。
  - **Red -> Green**: platform session/CSRF、tenant権限拒否、secret非応答・非ログ、validation before mutation、LINE token失敗zero-write、idempotent replay、partial Webhook failure、監査atomicity、狭幅/keyboard/step移動を確認する。
  - **完了(2026-08-21)**: `/platform-admin/tenants/new`へ5段階の案内を追加し、既存CLI provisioning処理をbrowser endpointから再利用した。platform session/CSRF/password-change gate、暗号化保存、LINE token確認、idempotency、atomic audit、秘密値非応答・成功後破棄を確認し、rich-menu公開・account activationは自動化していない。

- [x] **V030-5 repository seam inventory・conditional move**
  - v0.30.0の必須範囲は、V030-1〜4のgreen後に`apps/liff`、`apps/web`、`apps/worker`、`packages/db`の薬局custom seam、caller、public route、migration/test ownershipをread-only一覧化するところまでとする。
  - actual `git mv`は既定`DEFER`とする。責務不一致・重複ownershipが具体的な保守/安全上の欠陥を生むと証明され、別Human Gateで承認されたexact pathだけを独立commitで移動できる。未承認ならno-moveでv0.30.0を完了する。
  - move時も`myna/`現配置を第一候補とし、公開URL/API/DB table/migration ordering/runtime ownershipは維持する。domainごとの小さい`git mv`とreference更新だけに限定し、generated/local state/user-owned untracked file、dependency追加、全体format、将来用abstractionを混ぜない。
  - **conditional Red -> Green -> Refactor**: moveを承認した場合だけ移動前behavior、旧reference 0件、focused test、custom seam回帰を確認する。
  - **完了(2026-08-21)**: `apps/liff`、`apps/web`、`apps/worker`の`custom/pharmacy`、`custom_045`〜`custom_047` migration/test、entry route/callerをread-onlyで棚卸しした。責務不一致や重複ownershipによる具体的欠陥は確認されなかったため、既定どおり`git mv`は`DEFER`し、no-moveで完了とした。

- [ ] **V030-6 regression・dev受入・release準備**
  - rich menu draft/layout/catalog image/action/saved versions/管理画面切替/LINE lifecycle、公開中との差分、ON/OFF同期アシスト、tap link診断、CLI/API coverage/doctor、LIFF共通shell、薬局summary、全体管理readiness、scheduled reminderのfocused testsと薬局custom seam全体、typecheck、build、migration fixtureをgreenにする。repository move回帰はV030-5を別承認した場合だけ必須にする。
  - release用画像generatorを同じ入力で2回実行してcatalog manifestと全JPEG hashが一致すること、合法variantが228件で欠落/重複0件であること、各画像がCompact `2500x843`またはLarge `2500x1686`・JPEG・LINE byte上限内であること、catalog総容量が設定したdeploy上限内であることをgateにする。runtime/packageへ画像renderer依存を追加しない。
  - schema apply、code deploy、account activation、LINE candidate create/upload、set-default、rollbackは独立Human Gateとし、一つの承認から他を推論しない。deployだけでは全accountの新lifecycle/reminderをinactiveに保つ。
  - LINE mutation evidenceへactor、tenant/account、draft/revisions/hashes、expected current default、target remote ID、confirmation expiry、API result、post-mutation read-backを記録し、secret・credential・patient identifierを含めない。
  - synthetic accountで新規登録から初期設定を実行し、LINE default read-back後に左上「処方せん送信」が`pharmacy-prescription-send`を開くこと、緊急避妊薬が有効時だけ「すべての機能」から開けることを実端末で確認する。candidate upload前はdefault不変、全配置tap、画像/action一致、per-user override有無、disabled/全機能fallback、旧menu rollbackとread-back、reminder文面/lock-screen/時刻/取消も確認する。
  - code rollbackでは新activationを先に停止し、remote defaultを変えず、pending reminderを送らず、reconcile前にlegacy mutationを実行しないことを確認する。
  - package `0.30.0`、詳細`CHANGELOG.md`、seller tag `pharmacy-v0.30.0`、GitHub Release本文は全gate後に揃える。dev push/main merge/tag/deploy/account activation/LINE mutationは個別の明示指示を受ける。
  - **Oracle evidence**: session `pharmacy-v029-v030-split-review`、`requestedKey=gpt-5.6-sol`、`resolvedLabel=GPT-5.6 Sol`、`verified=yes`、`thinkingTime=pro`、transcript validation `ok`。判定`CHANGE`をdraft確定点、LINE lifecycle、reminder occurrence、activation、conditional moveへ反映済み。
  - **進捗(2026-08-21)**: release generatorを同一sourceから再実行し、228 JPEG、manifest、全SHA-256が既存local artifactと完全一致することを確認した。catalog総容量を50MB以下に制限するdeploy gateも追加し、現在artifactは36,954,062 bytes。development R2へ228画像とmanifestを登録し、全remote objectのbyte/hash/size一致を確認した。Worker rich-menu/DB/LIFF/Web/CLI・doctorのfocused testsはgreen。最新確認はWorker 93 files / 795 tests、Web薬局custom seam 28 files / 127 tests、LIFF薬局custom seam 16 files / 69 tests、deploy workflow・CLI契約 2 files / 62 tests。schema apply、deploy、account activation、LINE mutation、実端末受入、rollback drill、package/release metadataは未実行。

### V031 - privacy-safe menu分析・予約切替・preset共有 - 0.31.0実装予定

**位置付け**: seller release `pharmacy-v0.31.0`として実装予定。v0.30.0でimmutable draft、LINE create/upload/default/read-back、explicit rollback、capability同期、tap link診断がgreenかつsynthetic accountで実証された後に着手する。v0.31.0はmenu運用の改善に限定し、患者domainや緊急避妊薬reminderを同時拡張しない。

**目的**: 個人を記録しないmenu利用傾向を薬局ownerが把握し、検証済みmenuを指定日時に安全に切り替え、同一tenant内の別accountへallowlist配置だけを再利用できるようにする。

**非目標**: unique user数、患者追跡、friend/patient ID・IP・User-Agent・raw URL/queryのanalytics保存、緊急避妊薬等の関心推定、A/B test、患者別menu、AI最適化、任意条件式、毎週繰り返しschedule、任意URL/image/actionのaccount間copy、platform admin mutation。

**画面別アップデート候補**:

| surface | v0.31.0での候補 | 境界 |
|---|---|---|
| 患者LIFF | 対応中recordの時系列とserver-owned次行動 | owner認証済み最小projection、raw医療情報なし |
| 薬局管理画面 | domain横断action queue、menu分析・予約・preset UI | read-only union、domain mutationは既存detailのみ |
| 全体管理画面 | version/readiness/menu scheduleのfleet driftとsupport snapshot | 非PHI read-only、tenant比較analyticsなし |

- [ ] **V031-0 v0.30.0運用証拠とRed contractを固定**
  - v0.30.0のcurrent default read-back、rollback、partial failure、capability stale、tap preflight、operation auditをfixture化する。v0.30 readerがv0.31 schedule/aggregate dataを安全に無視し、予約LINE mutationを実行しないmixed-version testを作る。
  - analytics、schedule execution、layout copyは別々のaccount activationとし、deploy時は全account OFFにする。1機能のactivationから他を推論しない。
  - **受入条件**: base commit、対象account、current known-good remote ID、timezone、activation、rollback候補、zero-send/mutation baselineを追跡できる。

- [ ] **V031-1 個人を記録しないmenu action集計**
  - 指標名はunique tapではなく`menu action opens`とする。server-derived profile version、slot、allowlist action key、account timezoneの日付だけで日次counterをatomic incrementし、raw event rowを保存しない。
  - friend/patient ID、IP、User-Agent、referrer、raw URL/query、LIFF tokenをanalytics repository/API/logへ渡さない。少数行動からセンシティブな関心を推測しないよう、管理画面は7日以上の期間単位かつcount 5未満を「少数」として非表示にする。
  - 集計不能・重複page loadをunique userへ補正せず、menu以外のdirect accessが混ざる可能性を説明する。account別集計のみとし、platform全体の薬局比較ランキングを作らない。
  - **Red -> Green**: atomic increment、timezone境界、unknown action、disabled analytics、cross-account、raw identifier 0件、count抑制、API field allowlistを確認する。

- [ ] **V031-2 検証済みmenuの単発予約切替**
  - scheduleはv0.30でupload/read-back済みのimmutable draftとremote richMenuId、expected current default、account timezoneの将来時刻、schedule revisionを参照する。v0.31.0はaccountあたり未来のactive schedule 1件だけに限定し、繰り返し・祝日ruleを作らない。
  - ownerがpreview/diffと実行時刻を確認して予約する。取消・時刻変更はCASとauditを必須にし、変更は新confirmationを要求する。client-supplied remote ID、timezone、hashをauthorityにしない。
  - **Red -> Green**: past/ambiguous DST時刻、重複schedule、stale draft/default/capability、confirmation再利用、cancel/reschedule race、cross-accountを確認する。

- [ ] **V031-3 予約実行・read-back・失敗回復**
  - dedicated schedulerがdue rowをatomic claimし、実行直前にaccount activation、current capability/layout/LIFF revision、target upload evidence、fresh expected defaultを再確認する。一致しない場合は`BLOCKED`でLINE call 0件とする。
  - set-default成功後のfresh read-back一致でだけ`COMPLETED`とする。timeoutや結果不明は`UNVERIFIED`で停止し、blind retry・自動rollback・remote menu削除を行わない。明示再確認後だけresumeまたはv0.30 rollbackへ進める。
  - 1 accountの失敗で他account scheduleを止めず、audit/logへcredentialやpatient identifierを含めない。
  - **Red -> Green**: concurrent claim、early/late cron、stale expected default、timeout before/after mutation、read-back mismatch、multi-account isolation、explicit recoveryを確認する。

- [ ] **V031-4 同一tenant内のlayout preset共有**
  - copy対象はserver allowlistのslot action keyと順序だけに限定する。remote richMenuId、LIFF URL/ID、image/object key、hash、confirmation、credential、revision、analyticsはcopyしない。
  - destination accountのcapabilityと固定slot ruleで再検証し、unsupported/disabled actionを明示してediting stateまで作る。destination自身のLIFF IDとimage bytesから新draftを作り、公開はv0.30 lifecycleを使う。
  - **Red -> Green**: same-tenant owner、cross-tenant denial、disabled/unknown action、destination all-functions、source mutation後非連動、remote ID/hash非copyを確認する。

- [ ] **V031-L1 LIFF owner-scoped対応タイムライン**
  - 既存の処方せん、電子handoff、緊急避妊薬、継続/服薬後follow-upを新しいdomain modelへ複製せず、owner/account-scoped read-only union projectionとして更新日時順に返す。各itemはallowlist feature、表示用status、server-owned next action、既存detail routeだけを持つ。
  - patient/friend ID、処方内容、薬名、緊急避妊薬申告/risk、staff note、暗号化payloadをtimeline APIへ含めない。複数家族profileを扱う場合もclient queryをauthorityにせず、既存owner relationからserver-sideで許可された表示名だけを返す。
  - cursor pagination、empty/error/retry、OFF後active drainを扱い、client clockでstatusや期限を変更しない。timeline itemから新規受付を暗黙作成しない。
  - **Red -> Green**: owner/account scope、domain ordering/cursor、field allowlist、EC decrypt 0回、OFF drain、unknown status fallback、別owner 404、狭幅/keyboardを確認する。

- [ ] **V031-A1 薬局管理画面のdomain横断action queue**
  - V030-A1のsummaryから、処方せん、電子handoff、EC、follow-upの「対応が必要」recordだけをbounded union queryで取得する。表示はdomain、非センシティブstatus、deadline/経過区分、既存detailへのlinkに限定する。
  - queue自体はassign、status変更、一括処理、decrypt、free-text noteを持たない。各mutationは既存domain detailのauthorization/CAS/auditを通し、EC detailは研修修了薬剤師の監査後復号を維持する。
  - account、domain、status、deadlineのserver allowlist filterとstable cursorを使い、1 domainのcorrupt rowや失敗で他domain pageを越境・重複させない。
  - menu action opens、予約一覧、preset copyはV031-1〜4の個別UIとして同じ薬局管理shellへ追加するが、患者queueとanalyticsを一つのAPI payloadへ混ぜない。
  - **Red -> Green**: bounded cursor/filter、same-account union、stable ordering、EC list decrypt 0回、deep-link authorization、partial domain failure、cross-account、no bulk mutationを確認する。

- [ ] **V031-P1 全体管理画面のfleet drift・redacted support snapshot**
  - tenant/accountごとにseller release、LIFF/Web/Worker runtime version、canonical readiness revision、current menu evidence、active schedule statusを比較し、`CURRENT`/`STALE`/`BLOCKED`/`UNVERIFIED`でfilterできるread-only fleet viewを追加する。
  - redacted support snapshotはserver allowlistのtenant/account ID、version identities、status/reason、revision、checked_at、直近operation result codeだけをJSONで生成する。credential、secret名/値、remote token、patient/friend/staff ID、case count、menu action opensを含めない。
  - snapshot生成をPHI support modeやtenant mutation権限へ接続せず、download/copyをplatform auditへ記録する。snapshotから自動repair、deploy、activation、schedule変更、LINE mutationを行わない。
  - **Red -> Green**: version identity drift、readiness/menu/schedule stale、filter、snapshot field allowlist、audit、cross-tenant navigation、PHI/credential/analytics非露出を確認する。

- [ ] **V031-5 管理画面・回帰・release準備**
  - 薬局管理画面へ期間別action opens、予約一覧/取消/再開、preset copy previewを追加する。44px target、keyboard、狭幅、timezone明示、account切替、screen-reader statusを確認する。
  - analytics、schedule、copy、LIFF timeline、薬局action queue、platform fleet driftのfocused tests、mixed-version、tenant/account authorization、privacy field scan、scheduler concurrency、v0.30 rollback回帰をgreenにする。実LINE端末はsynthetic accountだけを使い、未来時刻の切替とread-backをHuman Gateで確認する。
  - package `0.31.0`、詳細`CHANGELOG.md`、seller tag `pharmacy-v0.31.0`、GitHub Release本文は全gate後に揃える。schema apply、deploy、activation、schedule作成、LINE mutation、dev push/main merge/tagは個別の明示指示を受ける。

### LIFF-MENU - メインメニュー階層 + 6分割リッチメニュー - 2026-08-20 実装計画

**目的**: 薬局LIFFに `/pharmacy/menu` のメインメニュー階層を追加し、患者向け薬局機能を1画面から直接開けるようにする。新規アカウントの初期リッチメニューは2500x1686の6分割へ変更し、低頻度・入力前提の「処方せん事前送信」「患者アンケート」はリッチメニュー直下から外してメインメニュー内のdirect URLへ移す。既存配信済みLIFF URLと旧3分割profileは壊さず、新profileを加算する。

**6分割の選定**: 日常的な確認・相談を上位に置き、入力負荷・センシティブ性が高い機能は「すべての機能」内へ集約する。

| 位置 | ラベル | action | 遷移先/送信内容 |
|---|---|---|---|
| 左上 | お薬を受け取る | URI | `page=pharmacy-receive` -> `/pharmacy/receive` |
| 中上 | 受付状況 | URI | `page=pharmacy-prescription-history` -> `/prescriptions?view=history` |
| 右上 | 服薬後フォロー | URI | `page=pharmacy-followup` -> `/pharmacy/medication-followup` |
| 左下 | 薬局へ相談 | message | 固定文言 `薬局へ相談`。自由入力・PHIをaction dataへ入れない |
| 中下 | 薬局情報 | URI | `page=pharmacy-info` -> `/pharmacy/info`。薬局名・営業時間・Google Maps等を表示 |
| 右下 | すべての機能 | URI | `page=pharmacy-menu` -> `/pharmacy/menu` |

- [x] **LIFF-MENU-0 現行導線・対象機能・互換境界を固定**
  - 「全機能」は現行 `App.tsx` に実装済みの患者向け薬局画面とし、処方せん事前送信、受付履歴、患者情報・アンケート、お薬を受け取る、継続フォロー、服薬後フォロー、緊急避妊薬、薬局情報、薬局への相談を対象にする。booking/event/affiliate/webinar等のgeneric LIFFは混在させない。
  - 既存 `/prescriptions`、`/pharmacy/*` routeと旧`page=pharmacy-*` URLは維持する。queryの`liffId`・`followUpId`・`submissionId`を落とさず、query parameterをtenant authorityにしない。
  - **受入条件**: 上記mappingと全direct URLがsource/testで一意に対応し、旧URL互換とserver-side account authorizationを維持する。

- [x] **LIFF-MENU-1 メインメニュー画面とdirect URL**
  - `custom/pharmacy/menu` に最小のデータ定義と画面を追加する。カード全体を44px以上のリンクにし、見出し・短い説明・状態に依存しないアイコンを持たせる。画面内にセンシティブな患者状態やAPI取得結果は表示しない。
  - 処方せん画面は `view=send|history` をallowlistで解釈し、事前送信と受付状況を別direct URLとして開けるようにする。不正値は既存の`send`へ安全にfallbackする。
  - 薬局への相談はLIFFの`sendMessages()`で固定文言だけを送る確認付きbuttonとし、失敗時は画面内エラー、成功後は重複送信を防ぐ。message送信を使えない外部browserでは説明を返す。
  - **Red -> Green**: 全カード、direct `view`、`liffId`保持、相談confirm/error/busy、semantic heading/link/button、未知route 404を先にtestで固定する。

- [x] **LIFF-MENU-2 legacy query routingを加算**
  - `pharmacy-menu` と `pharmacy-prescription-history` を `PHARMACY_LEGACY_PAGE_TARGETS` に追加する。既存keyは変更・削除しない。
  - rootのgeneric `page=null -> /booking` は後方互換のため維持し、薬局トップは明示的な `/pharmacy/menu` / `page=pharmacy-menu` とする。
  - **Red -> Green**: 新旧page key、query保持、unknown pageの安全fallbackを`legacy-route.test.ts`で確認する。

- [x] **LIFF-MENU-3 account-scoped薬局情報の保存・管理・患者表示**
  - 加算migration `custom_039_pharmacy_public_profile.sql` で `pharmacy_public_profiles` を作る。`line_account_id`をPK/FKとし、薬局名、電話番号、郵便番号、住所、営業時間(患者向け自由記述)、休業日・臨時案内、アクセス案内、駐車場案内、Google Maps URL、最終更新日時を保持する。PHI・staff個人情報・内部メモは保存しない。
  - Google Maps URLは`https:`かつGoogle Mapsのallowlist hostだけを許可し、未設定時は住所から`https://www.google.com/maps/search/?api=1&query=`を安全に生成する。電話は`tel:`用文字列を数字・`+`・`-`へ制限し、自由記述をURLへ流用しない。
  - staff API `GET/PUT /api/custom/pharmacy/public-profile` は既存staff/account authorizationと`line_account_id` scopeを必須にする。LIFF API `GET /api/liff/pharmacy/public-profile` は認証済みLIFF identityからaccountをserver-side解決し、queryをauthorityにしない。未設定時はaccount表示名だけの最小projectionを返す。
  - 管理画面 `/pharmacy-info` を薬局機能sidebarへ追加し、選択accountごとに上記項目を編集する。保存中の二重送信防止、入力エラー、保存結果、未保存変更を明示する。
  - LIFF `/pharmacy/info` は薬局名を先頭に、`本日の営業時間`ではなく誤判定を避けた「営業時間」全文、住所、Google Maps、電話、休業日/臨時案内、アクセス・駐車場を読みやすいカードで表示する。外部リンクは`noopener noreferrer`、電話/地図は44px以上、API失敗時は再試行を出す。
  - **Red -> Green**: migrationのaccount FK/越境、repository validation、staff別account否定、LIFF identity別account否定、Google host/`javascript:`拒否、未設定fallback、管理画面form、LIFF loading/error/empty/full projectionを確認する。

- [x] **LIFF-MENU-4 6分割large profileと初期設定**
  - 新profile key `initial-large-3x2-v2`、generator version `2`、size `large`を追加し、3列幅`833/834/833` x 2行高`843/843`でLINE座標全体を隙間・重複なく覆う。
  - bodyの`profileKey`省略時は新profileを選ぶ。旧`initial-compact-3x1`と`intake-single-action-v1`は明示指定時の互換profileとして残す。新profileは別generator keyで作り、既存published menuを暗黙更新・削除・default適用しない。
  - account/tenant/capability/LIFF ID検証、draftのみreconcile、R2 image存在確認、race時のgenerator unique再利用を維持する。初期設定変更はlocal draft生成defaultまでで、LINE publish/default設定は既存の明示Human Gateを維持する。
  - **Red -> Green**: 6area座標・action mapping・default profile・旧profile明示互換・published非書換・別tenant否定・idempotent retryを確認する。

- [x] **LIFF-MENU-5 リッチメニュー画像を作成・検証**
  - image generationで医療情報や患者写真を含まないフラットな6分割画像を作る。白〜淡緑基調、濃い文字、各枠に単純な識別アイコン、右下を視覚的に「すべての機能」と判別できる構成にする。
  - final assetは `apps/worker/public/custom/pharmacy/rich-menu/initial-large-3x2-v2.jpg`、2500x1686、JPEG、1MiB以下。action labelと画像ラベルを完全一致させ、境界線をtap座標と一致させる。
  - **Red -> Green**: `validateRichMenuImage()`、実寸、file size、profileのimage path/file name/content typeをtestで固定する。画像生成物は目視確認する。

- [x] **LIFF-MENU-6 横断回帰・完了監査**
  - LIFF navigation/legacy/menu/prescriptions/public-profile、Worker rich-menu/profile/public-profile routes、Web pharmacy-info、DB migration/generator isolation、既存薬局LIFF画面、`git diff --check`を実行する。
  - automated notification、manual reply header、Meet consultation、PHI、tenant/account authorizationには変更を入れない。push/PR/deploy/LINE publish/default適用/production mutationは実施せず、実機tap確認と公開操作をHuman Gateとして残す。
  - **実装証拠(2026-08-20)**: image generation由来の`2500x1686` JPEG(352,635 bytes)を目視・validator確認。最終回帰はWorker 187 files / 1727 tests、LIFF 18 / 67、Web 34 / 165、DB 52 / 285が成功し、`git diff --check`も成功。push/PR/deploy/LINE publish/default適用/production mutationは未実施。

### FLE - pharmacy intake field-level encryption - 2026-08-20 実装計画

**目的**: `pharmacy_patient_intake_responses.answers_json` と `patient_snapshot_json` の平文保存を、既存の `PHARMACY_PHI_KEY_V1` と Web Crypto を使うapplication-layer AES-256-GCMへ段階移行する。暗号化はauthorizationの代替にせず、既存の `line_account_id`・`owner_friend_id`・`patient_id` scopeを維持する。ローカル実装・migration生成・テストと、secret投入・本番backfill・plaintext scrub・restore drill・security/human approvalは別の証拠として扱う。

- [x] **FLE-0 現行flow・設計・移行境界を固定**
  - 全read/write callerは患者LIFFのlatest intake、staffのlatest/history、期限付き`phi:read` grant配下のplatform-admin patient history。通知・一覧summary・検索条件へanswers/snapshotを追加しない。
  - 既存 `emergency-contraception/encryption.ts` は同じroot secretを使うが、AADと2KiB上限がintake契約に合わないため再利用しない。`line-credentials.ts` のversioned key・Web Crypto・strict base64url検証だけを最小の専用moduleへ踏襲し、新dependencyや汎用暗号frameworkは作らない。
  - **受入条件**: 対象2field、全caller、rollback、外部Human Gateが本文とtest名で追跡でき、R2・patient profile・fulfillment codesへscopeを広げない。

- [x] **FLE-1 加算envelope schemaと暗号primitive**
  - `custom_040` で `pharmacy_patient_intake_envelopes` を追加する。1 response x 1 fieldの行とし、`response_id`・`line_account_id`・`owner_friend_id`・`patient_id` の複合FK、`field_name` allowlist、`schema_version`、`source_revision`、`envelope_version`、`key_version`、96-bit `nonce`、`ciphertext`、`encrypted_at`を保持する。旧table/columnは変更・削除しない。
  - `UNIQUE(key_version, nonce)` で同一key nonce再利用をDBでも拒否する。AADはtenant/account/owner/patient/response/schema/revision/field/envelope versionを含み、wrong scope・field swap・tamper・unknown versionはfail closedする。
  - **Red -> Green**: 実SQLite migration testとprimitive testを先に追加し、複合FK越境・field allowlist・nonce重複・round trip・AAD swap・tamper・secret未設定を確認する。bootstrap artifactsはmigration test green後に既存generatorで同期する。

- [x] **FLE-2 authorization後のdual-read**
  - owner/staff/platform-adminの既存scope解決後にのみenvelopeを読み、2fieldが両方存在するときだけ復号する。片方欠損・malformed・decrypt失敗時はlegacy plaintextへfallbackせずgeneric 5xxでfail closedする。
  - envelopeが2fieldとも存在しないlegacy rowだけは、scrub完了まで旧JSONを読む。staff historyは選択したlatest responseだけ復号し、summary/list queryは平文・ciphertextをprojectionしない。
  - **Red -> Green**: encrypted優先、legacy fallback、partial envelope拒否、wrong-account/AAD拒否、owner/staff/platform-admin callerへのsecret伝播、response/logへのciphertext・内部error非露出を固定する。

- [x] **FLE-3 新規回答をencrypted-write-firstで原子的に保存**
  - 次revisionをscope内で決定し、response rowと2 envelope rowを同じ`db.batch()`で保存する。legacy列には互換用JSONを一時保存するが、暗号化またはenvelope insert失敗時はresponseを残さない。idempotency再試行は既存rowをdual-readし、異なる同時revisionは409相当を維持する。
  - secret未設定はD1書込み前に503でfail closedする。payload・ciphertext・nonce・patient identifierをログへ出さない。
  - **Red -> Green**: atomic rollback、idempotent retry、concurrent revision conflict、archived/wrong-owner拒否、missing-key 503、既存consent/policy proofを確認する。

- [x] **FLE-4 bounded/resumable backfillとcoverage**
  - scopeとcursorを必須にした小batchでlegacy rowを暗号化し、encrypt -> decrypt -> byte-compareした2fieldだけをCASで挿入する。既存envelopeは上書きせず、partial/corrupt/mismatchで停止する。
  - coverageはtenant/account単位の件数とerror codeのみ返し、payload・ciphertext・nonce・patient IDを出さない。dry-runをdefaultにし、production mutationは実行しない。
  - **Red -> Green**: batch上限、cursor再開、既存row skip、CAS競合、partial/corrupt停止、tenant/account scope、PHI-free reportを確認する。

- [x] **FLE-5 plaintext scrub・restoreを明示Human Gate付きで実装**
  - coverage 100%、decrypt byte-compare、named approvalが揃ったrowだけ、legacy 2fieldをvalid empty JSON sentinelへ同一更新する。復号不能・partial envelope・coverage不足では1行もscrubしない。
  - rollbackはverified envelopeから旧2fieldを復元するbounded toolを用意し、old Workerへ戻す前にrestore drillを要求する。secret投入、本番backfill/scrub/restoreはこの作業では実行しない。
  - **Red -> Green**: approval欠如、coverage不足、tamper、途中再開、sentinel判定、restore byte equality、PHI-free reportを確認する。

- [x] **FLE-FINAL 完了監査**
  - migration/bootstrap/update-engine、intake repository/routes、platform-admin grant否定、LIFF/Web表示、`git diff --check`を実行する。local greenを本番暗号化完了と呼ばない。
  - production completion gateはsecret provisioning、migration evidence、account別coverage 100%、scrub、restore drill、security review、named human approval。未実施なら`NOT_RUN`/Human Gateとして残す。
  - **ローカル実装証拠(2026-08-20)**: `custom_040/041`、AES-GCM primitive、全caller dual-read/encrypted-write-first、dry-run既定のbounded backfill/coverage、named approval付きwrite-freeze/scrub/restore、CLI専用platform endpointを実装。`pnpm -r typecheck`、全package test（LIFF 18 files/67 tests、DB 56/304、Web 34/165、Worker 188/1737、その他workspace 336 tests）、script 14/121、additive migration 72件、`git diff --check`が成功。secret provisioning、本番migration/backfill/coverage/scrub/restore、restore drill、security review、named production approvalは`NOT_RUN`/Human Gate。
  - **Oracle advisory**: `fle-final-security-review` はGPT-5.6 Sol/browser/Pro指定でdry-run後に開始したが、既存Oracle processのbrowser profile lockが300秒継続し、session status `error`。model回答・verified evidenceは得られず`BLOCKED`。fallbackや重複実行はしていない。

### U22 - upstream v0.22.0 選別取り込み + follow-up 境界整理 - 2026-08-20 実装計画

**比較基準**: 現行 `dev` HEAD `7cd1c76` と upstream tag `v0.22.0` (`c20c04f`) を機能単位で比較する。tag 全体は現行より古く、薬局 custom seam・tenant authorization・通知停止・PHI保護を欠くため、merge/cherry-pickはしない。既存コードへ最小差分で再実装し、各項目を Red -> Green で確認する。

- [x] **U22-0 候補選別と古い計画記述の整合**
  - upstream の実質機能は admin SSO、LINE Login/LIFF未設定時の案内、友だち追加リンクのapp-first化、管理画面内の読み取りにくいQR削除、brand/docs更新に分ける。
  - **採用**: LINE Login/LIFF未設定時の503案内、読み取りにくい管理画面内QRの削除。
  - **不採用**: admin SSOは発行元・tenant binding・platform-adminとの権限関係が未定義で、既存の個人別tenant/platform admin認証を迂回する新経路になるためYAGNI。app-first `/r/dashboard?account=` は現行のpharmacy modeで `/r/:ref` を明示的に404にする境界と衝突するため、その製品判断なしには入れない。brand/docs一括変更と依存関係の巻き戻しも行わない。
  - `PLANS.md` 内の `.env.example`、V-3/V-4、`liff.ts`、H-4/H-5/H-6、E-6/E-7に関する古い「未実装/blocked」記述は、現行コード・後続完了節・Human Gateに合わせて履歴として訂正する。field-level encryption、retention残作業、Myna low、外部MFA/別originは完了扱いにしない。
  - **受入条件**: 採用/不採用/外部Human Gate/後続実装が混在せず、完了済み項目について現行証拠と矛盾する「未実装」表現が残らない。

- [x] **U22-1 LINE Login/LIFF未設定を500ではなく503で案内**
  - upstreamの `login-unconfigured` パターンを再利用し、`/r/:ref`、`/auth/line`、`/auth/oauth`、`/auth/callback` で、account/pool/envを解決した後も有効なLIFF URLまたはLINE Login channel設定がない場合にfail closedする。
  - 患者・友だち向け応答へ内部設定名、secret、tenant情報を出さず、`noindex` と管理者向け設定案内だけを返す。薬局専用LIFF routeや既存のaccount/tenant選択順序は変えない。
  - **Red**: 未設定env/accountで現在の `liffUrl.match()` 例外または `client_id=undefined` を再現するroute testを先に追加する。
  - **Green**: 503、設定案内、`noindex`、秘密情報非露出を確認し、設定済みの既存リダイレクト/landing testも再実行する。

- [x] **U22-2 管理画面内の読み取りにくいQRを削除**
  - upstream `bf2b5da` と同じく、角丸・quiet zone不足の240px QRを `FriendAddLinkCard` から削除する。リンクコピーは維持し、PC利用者は既存 `/auth/line` landingの24px padding付きQRを使えるため、新しいQR実装や依存関係は追加しない。
  - **Red**: dashboardのsource/component contractで問題のQR toggle/imageが存在することを固定する最小テストを先に追加する。
  - **Green**: QR toggle/imageだけが消え、選択accountの友だち追加リンクとcopy操作が残ることを確認する。

- [x] **FUP-SCOPE-1 LIFF friend-add scenarioの二重防御をfail-closed化**
  - `getScenariosForAccount(null) -> []` は既に実装済みだが、`liff.ts` の追加条件 `!scenario.line_account_id || !matchedAccountId || ...` はhelperが誤った行を返した場合にaccount-bound scenarioを許す。共有helperを変えず、route側の `!matchedAccountId` 許可だけを削除する。
  - **Red**: account lookupがnullなのにaccount-bound scenarioが返る回帰fixtureでenrollされる現状を再現する。既存のaccount未紐付きscenarioのnull-account挙動は維持する。
  - **Green**: account-bound scenarioはenroll/pushされず、account未紐付きscenarioと一致account scenarioは従来どおり動作する。LIFF 2 suiteとDB `custom_024` scope suiteを再実行する。

- [x] **FUP-API-1 患者follow-up APIの重複JSON処理を共通化**
  - `medication-followup/api.ts` 内の独自 `json()` を削除し、既存 `requestPharmacyJson()` を再利用する。新規helper・dependency・domain modelは追加しない。
  - **Red**: API testを共通helper契約へ変更し、list/respondが同じ安全な境界を通ることを先に固定する。
  - **Green**: 既存のrequest境界が持つ401/403/404/409/429/500/503の安全な日本語エラーとstatus/body保持をfollow-upにも適用し、follow-up API/Pageとrequest testを再実行する。

- [x] **FUP-ERROR-1 staff follow-up routeの内部エラー非露出**
  - schedule/transition routeがrepositoryの`error.message`をそのまま返す処理を、400/404/409/500の安全な固定文言へ集約する。既知のinvalid/not-found/conflictだけを分類し、未知エラーは500でfail closedする。
  - **Red**: SQLite/内部識別子を含む未知エラーが現状400本文へ露出するfixtureと、既知conflictの409契約を追加する。
  - **Green**: 未知エラー本文に内部文言がなく500、既知not-found/conflictは404/409を維持し、account/capability否定テストを含むroute suiteを再実行する。

- [x] **REF-CONFIG-1 Vite 8 config loader警告をstdlibで解消**
  - `apps/worker/vitest.config.ts` の暗黙 `__dirname` を、既存Node標準の `dirname(fileURLToPath(import.meta.url))` へ置換する。Node engine `>=20` 全域を守るため `import.meta.dirname` には上げない。
  - CommonJS package内でESM syntaxを使う `apps/web`・`packages/db`・`packages/line-sdk` のVitest configは、内容を変えず `.mts` へ移してnative loaderへ明示する。
  - **Red**: 現在のfocused test出力に `configLoader: 'native'` / `__dirname` 警告が出ることを記録済み。
  - **Green**: Worker/Webの対象testが同じ件数で成功し、警告が消えることを確認する。

- [x] **U22-FINAL 完了監査**
  - 採用項目ごとのtest、follow-up tenant否定test、`git diff --check`を実行する。関連テストの成功をローカル実装証拠として記録し、push/PR/deploy/production operationや外部Human Gate完了とは区別する。
  - upstream由来の変更が `custom/pharmacy` 境界、`line_account_id`、server-side authorization、PHI-free notification、manual送信header規約を弱めていないことをdiffで確認する。
  - **実装証拠(2026-08-20)**: Worker 185 files / 1715 tests、Web 32 / 162、LIFF 15 / 59、DB `custom_024` 6、line-sdk 3が成功。Vite 8 config loader警告は解消し、`git diff --check`も成功。push/PR/deploy/production operationは実施しておらず、field-level encryption・処方箋画像以外のretention・Myna low・外部MFA/origin/role/alert・R2実機確認は未完了のまま維持する。

### 前提・検証メモ
- 当初対象は `v0.26.0/feature/logical-multitenancy`。2026-08-20時点の継続作業は `pharmacy-harness-line` の `dev`、開始HEAD `7cd1c76`で実施する。
- 2026-08-19: 元のセキュリティレビュー(Artifact/MD)に対し外部レビュー(REQUEST_CHANGES)を受領。指摘のうち検証可能なものは実コードで裏取りした上で本計画に反映した。盲信も無視もしていない。
- **検証して却下した指摘**: 「`GET /images/:key` が無認証で処方箋・マイナ・着信チャット画像を配信している」という主張は、実コード(`apps/worker/src/routes/images.ts:103-119`)と矛盾するため却下。`/images/:key` は `PUBLIC_IMAGE_KEY` 正規表現(裸UUID.ext または `tenants/{id}/uploads/{uuid}.ext`)にマッチするキーのみ配信し、着信チャット画像のキー形式(`tenants/{id}/accounts/{id}/incoming/{id}.ext`)はこれにマッチしない。着信画像は別ルート `GET /api/images/:key`(:112-119)を通り、`canReadIncomingImage` でテナント所有権を検証してから配信される。外部レビュー自身が「GitHub上で指定ブランチを参照できず、main/dev(v0.25.0相当)で照合した」と明言しており、対象ブランチの差分に起因する誤指摘と判断。H-5「アクセス制御は正しい」の所見は維持する。
- **妥当と判断し反映した指摘**: D1 `batch()` はSQLエラー時のみロールバックし、UPDATEが0件マッチしても「失敗」扱いにならない(→H-2の修正方針を再設計)。Cloudflare Workersはisolate間でモジュールグローバル状態を共有する保証がない(→H-1の深刻度表現を修正)。薬剤師法の条番号誤り(27条/28条)。個人情報保護法(APPI)関連所見は「違反確定」ではなく「コード上の証跡不足」に言い換える。
- **未検証のまま計画に組み込んだ指摘**: 外部レビューが言及した「current-worktree レビュー」(broadcasts/booking/tag/generic webhook の越境所見)は、本セッションでは原文・対象コードともに未確認。裏取りせずタスク化はできないため、P1に調査タスクとして計上した(V-1〜V-5)。
- 2026-08-19: V-1〜V-5を実コードで調査完了(結果はP1参照)。M-9(R2バケット名のdev/prod分離)を直接実施済み。P0/P1/P2/P3/P5の残タスクは、ファイルが重複しない10バッチに分けて実装・検証し、同日中に全バッチ完了した。
- **運用メモ(マイグレーション番号衝突)**: 並列実行の副作用として `custom_023_pharmacy_staff_api_key_hash.sql`(L-4バッチ)と `custom_023_pharmacy_webhook_durable_inbox.sql`(H-3バッチ)が同一番号で衝突していたのを検知し、前者を `custom_027_pharmacy_staff_api_key_hash.sql` へリネームして解消した。最終的に `custom_023`〜`custom_027` の5ファイルで衝突・欠番なし。
- **運用メモ(スキーマ変更の相互作用)**: M-8バッチの`custom_026`が当初テーブル再作成(DROP+RENAME)方式でCHECK制約を拡張しており、M-5/M-6バッチが検証した「安全なD1更新は破壊的スキーマ変更を拒否する」というガードに抵触することが判明。既存テーブル拡張ではなく新規加算テーブル方式に本人が書き直して解消(詳細はM-8参照)。
- **2026-08-19 完了: 10バッチすべて完了。** `bootstrap.sql`/`bootstrap-meta.json`を最終再生成し、モノレポ全体で最終検証を実施 ― `pnpm -r test`: line-sdk 3/3・sdk 55/55・liff 31/31・db 248/248・update-engine 215/215(`upgrade-matrix.test.ts`含む)・create-line-harness 61/61・web 52/52・worker 1541/1541(169ファイル)、全てグリーン。`pnpm -r typecheck`: 全パッケージエラーなし。P0/P1/P2/P3/P5は全項目完了。P4(法令遵守)とL-10(依存関係更新)は上記のとおり意図的に対象外。
- **2026-08-19: 13コミットに分けてコミット済み**(`docs:`/`fix:`/`feat:`/`chore:` の粒度で機能ごとに分割、コミット順は本ファイルの記録と対応)。未追跡の `.claude/`・`.omc/`・`out/` は本セッションの作業物ではないため意図的に含めていない。`.env.example` の `STAFF_API_KEY_HASH_SECRET` は後続コミット `b4a5ec9` で追記済み。PR作成は引き続き人の判断事項。

### 新機能: 全体管理者(Platform Admin)ロール — ローカル実装完了・本番Human Gate残り
2026-08-19、ユーザー指示によりP0〜P5の修正完了後に新規追加。各テナント管理者の上位に位置し、**個人の診療記録を含む全データ**(処方箋・問診・マイナ・服薬継続)を越権的に閲覧・編集できる新ロール。スコープはユーザーに確認済み(質問で確定): アクセス範囲は個人PHIまで含む全データ、ログは「監査ログ・Webhook/配信ログ・全体管理者自身の操作ログ」の3種。

**設計方針**: 既存の`tenant_admin_credentials`/`tenant_admin_sessions`パターン(オペークセッション・ハッシュ化トークン・credential_version・must_change_password)を踏襲しつつ、テナントに紐付かないため**テーブル・Cookie・ミドルウェアを完全に分離**(`platform_admins`/`platform_admin_credentials`/`platform_admin_sessions`/`platform_admin_access_events`、Cookie名`lh_platform_admin_session`、`platformAdminAuthMiddleware`)。既存のテナント境界ミドルウェア群(`tenantAccountSelectorGuard`等)は`tenantId`未設定時にno-opする設計のため干渉しない。既存の`PLATFORM_ADMIN_KEY`(CLIプロビジョニング用の共有シークレット)とは別物 ― 個人を特定した監査証跡を残すため、全体管理者は個別のstaff身元を持つ人間ログインとして設計。

**「テナント情報を越権的に編集」のスコープ判断**: `tenants`テーブルの`display_name`/`status`(active/suspended)のみを編集対象とし、`tenant_code`(不変識別子)は対象外とした。理由: tenant_codeの変更はログイン導線を壊すリスクが高く、今回のスコープでは不要と判断。

**最重要の安全策**: 全体管理者によるテナント越境の読み取り・書き込みは**すべて**`platform_admin_access_events`に記録する設計とした(`recordPlatformAdminAccess`/`platformAdminAccessStatement`)。個人PHIまで含む越権アクセスを許可する以上、この監査証跡がAPPI上の説明責任の唯一の担保になる。

**進捗**:
- [x] 認証コア(自分で直接実装、検証済み): `custom_028_platform_admin.sql`(スキーマ)、`custom/pharmacy/platform-admin/auth.ts`(Cookie・セッション解決・ミドルウェア)、`custom/pharmacy/platform-admin/audit.ts`(監査記録ヘルパー)、`middleware/auth.ts`への`buildCookie`のexportと`/api/platform-admin/*`の認証迂回配線、`provisioning/credentials.ts`への`pas_`プレフィックスのセッショントークン関数追加。`apps/worker`型チェック・既存`auth.test.ts` 41/41 成功、`bootstrap.sql`同期確認済み。
- [x] バックエンドルート・プロビジョニングスクリプト・配線 完了(2026-08-19)。`custom/pharmacy/platform-admin/routes.ts` に11ルート実装(ログイン/ログアウト/セッション確認/パスワード変更/テナント一覧・詳細・編集/患者横断一覧・詳細/ログ閲覧/自己監査ログ)。`scripts/custom/pharmacy/bootstrap-platform-admin.ts`(初回発行CLI、`POST /api/platform/pharmacy/platform-admins` を既存の `rejectUnauthorizedPlatformRequest` で保護、姉妹スクリプトのHMAC決定的パスワード方式を踏襲しリプレイ安全性を確保)。`index.ts`への配線完了。テスト: `apps/worker` 171ファイル1570テスト成功、`scripts` 14ファイル117テスト成功、`tsc --noEmit`エラーなし。監査カバレッジはフィクスチャ差分テストで強制(新規ルート追加時にフィクスチャ未登録なら失敗する設計)。
  - **本人が直接コードを精査し確認した点**: テナント編集は`displayName`/`status`のみを厳格ホワイトリスト(それ以外のキーが1つでもあれば400)。テナント編集・パスワード変更は監査イベントと同一`db.batch`でコミット(H-2/M-3で確立した「状態変更と監査は同一トランザクション」の原則をこの新機能にも一貫して適用)。全SQLはパラメータ化されておりインジェクションのリスクなし。患者PHI取得は既存の`getAdminPharmacyPatientHistory`/`listAdminPharmacyPatients`/`listAccountExpectations`/`listMynaHandoffs`(いずれも本セッションで既にテナント境界の検証を済ませたコードパス)への委譲のみで、新規SQLを書いていない。
  - **本人が直接修正した1件**: `platformAdminAuthMiddleware`のmust_change_password強制が`/logout`もブロックしてしまい、初回ログイン(bootstrap)の管理者がパスワード変更前にログアウトできない状態だった(エージェントが検出・報告、意図的に自スコープ外として未修正のまま報告)。`/api/platform-admin/logout`を許可パスに追加して解消、`auth.test.ts` 41/41・`platform-admin`関連70テスト成功を確認。
- [x] フロントエンド(apps/web) 完了(2026-08-19)。`/platform-admin/{login,tenants,tenants/detail,tenants/patients,tenants/patients/detail,logs,audit}` の7ページ。`apps/web`は`output: 'export'`(静的サイト生成)のためNext.jsの動的ルートセグメントが使えず、このアプリの既存規約(`?id=`クエリパラメータ、例: `scenarios/detail`)に倣う設計変更をエージェントが自律的に実施(仕様の逸脱ではなく、既存規約への正しい追従)。テナント編集フォームは`displayName`/`status`のみ送信し`tenantCode`は送らない(バックエンドのホワイトリストと一致)。CSRFトークン・localStorageキーは`lh_platform_admin_*`で完全分離。全ページに「全体管理者モード」の常時バナー表示。テスト59/59成功、`pnpm --filter web build`成功(全7ページ含め静的プリレンダリング確認)。
  - **本人が直接精査した点**: `layout.tsx`のガード(未認証/要パスワード変更でログイン画面へリダイレクト)、`platform-admin-api.ts`のCSRF処理・全ID値の`encodeURIComponent`を確認、実装品質を承認。
- [x] 統合テスト・モノレポ全体の最終検証・コミット 完了(2026-08-19)。`pnpm -r typecheck`全パッケージエラーなし、`pnpm -r test`全パッケージグリーン(worker 171/1570・db 47/248・update-engine 22/215・web 21/59・liff 11/31・sdk 13/55・line-sdk 1/3・create-line-harness 8/61、いずれもファイル数/テスト数)、`pnpm --filter web build`成功。4コミットに分割してコミット済み(`feat(db)`/`feat(pharmacy)`/`feat(web)`/`docs`)。
- [x] 機能まとめmdファイル作成・送付 完了(2026-08-19、ユーザー指示)。

### 外部レビュー(2回目、platform-admin仕様書に対する「条件付きNo-Go」)への対応 — 2026-08-19

前回同様、実コードで一つずつ検証した(レビュアー自身も「コード・マイグレーション・Cookie属性・テストは未確認、仕様書のみのレビュー」と明言している)。

**実コードで確認し、修正した妥当な指摘(3件、コミット済み)**:
- [x] **Cookie の Path属性がサイト全体(`Path=/`)** だった。`/api/platform-admin` にスコープするよう修正(`buildCookie`にオプション引数追加、既存呼び出し元は`/`のまま非破壊)。ただし本対策は「意図的にそのパスを狙うfetch」までは防げない旨、ユーザーへの回答で明記。
- [x] **`GET /audit?all=true`(他の全体管理者の履歴閲覧)が監査対象外**だった。`view_audit_all`イベントとして記録するよう追加(自分の履歴閲覧は従来どおり対象外のまま — 無限再帰を避けるための意図的な区別)。
- [x] **bootstrap発行APIが`PLATFORM_ADMIN_KEY`だけで無制限に全体管理者を追加作成できた**。2人目以降は既存の有効な全体管理者セッションも必須に変更(`platform_admins`にis_active行が1件以上あれば、Cookieによる既存管理者セッション検証を追加要求)。`granted_by`も固定文字列ではなく実際の発行者IDを記録するよう修正。テスト2件追加(制限なしでは403・既存セッションありでは201かつgranted_by記録)。

**実コードと矛盾するため却下した指摘**:
- 「`patientId`がテナント間で衝突し誤帰属しうる」(重大度High) → `pharmacy_patients.id`は`TEXT PRIMARY KEY`でテーブル全体にわたり一意。レビュアーが提示したテストケース(「Tenant AとTenant Bに同じpatientId」)はスキーマ上構成不可能。
- 「`status=suspended`の意味・影響範囲が未定義」 → `tenants.status='active'`は本セッション以前から既にログイン・LINE認証情報取得・継続フォロー・growth-loop等15箇所以上で一貫して参照されている既存の確立済みゲート。新機能で新設したものでも未定義のものでもない。
- 「同一オリジンXSSによるCookie自動送信でPHI窃取可能」(重大度Critical・能動的脆弱性として記載) → `apps/web`/`apps/liff`全体に`dangerouslySetInnerHTML`の使用は0件、React/JSXのデフォルトエスケープにより既知の格納型XSS経路は確認できなかった。「同一オリジンに高権限画面と低信頼コンテンツ描画画面が同居するリスク」という設計上の懸念自体は妥当だが、"Critical・能動的な脆弱性"と言えるだけの実証されたXSS経路は本セッションでは発見できていない。
- 「処方箋ファイルのR2直接配信・X-Content-Type-Options等」 → 現状の患者詳細ビューはメタデータ(状態・日時)のみを返しR2の実ファイルバイトへの参照は一切含まない。この機能には現状該当しない。
- 「PHI閲覧時の監査INSERT失敗時にレスポンスを返すか不明」 → 確認済み。全PHI関連ルートは`await recordPlatformAdminAccess(...)`をレスポンス返却の**前**に実行しており、関数自体もエラーを握りつぶさない(try/catchなし)ため、監査書き込み失敗時はHonoが500を返しPHI本文は送出されない。既にfail-closed。

**経営判断が必要なため実装せず、ユーザーに確認する**: MFA/re-authentication必須化、全体管理者専用の別オリジンへの分離、ロール細分化(Operator/Support/Auditor/Root)。いずれも大きなインフラ・製品判断を伴うため、下記の新規提案とあわせてユーザーに優先順位を確認する。

### 新規提案: Tenant Control Center + 期限付きサポートモード — MVPローカル実装完了・外部Human Gate残り

2026-08-19、ユーザーから大規模な追加提案を受領。現行の「常時全権閲覧」ではなく、通常モード(PHI非表示・稼働状況/整合性/セキュリティの監視)とサポートモード(理由・チケット番号・期限・MFA再認証を伴う一時的なPHIアクセス)の2層構成への再設計。ユーザーは選択式確認の結果「最小MVP一式(ダッシュボード+サポートモード+基本操作)」を選択。

**MVPの範囲(提案書「5. 推奨する最小MVP」に対応)**: 全体ダッシュボード / テナント一覧・概要 / LINE連携状態 / スタッフ・セッション / データ整合性 / 監査ログ(既存) / サポートモード内の患者閲覧。操作: サポートモード開始・終了 / テナント停止・再開(既存statusを流用) / LINE送信一時停止・再開 / テナント全セッション失効 / スタッフ無効化 / LINE接続テスト / 失敗Webhook・ジョブの単体再試行。

**注意(スコープ外として明示)**: 提案が求める「全体管理者専用の別オリジンへの分離」「Cloudflare Access + MFA」は、DNS・ホスティング・IdP設定などクラウドコンソールへの実アクセスが必要でこのセッションからは実行不可能。MFAの代替として、サポートモード開始時に**現在のパスワードの再入力(step-up)**を必須化した(`access-grant.ts`にコード内コメントで「真のMFAの代替ではない」旨を明記)。真のMFA・別オリジン化は運用チーム側で別途対応が必要。

**進捗**:
- [x] コア(自分で直接実装、検証済み・コミット済み): `custom_029_platform_admin_access_grants.sql`(グラントテーブル)、`platform-admin/access-grant.ts`(`createAccessGrant`=step-up付き発行、`requireActiveGrant`=強制、`endAccessGrant`、`listActiveGrants`、パスワード変更時のカスケード失効)。患者PHIの2ルート(`/tenants/:id/patients`、`/tenants/:id/patients/:patientId`)を有効なグラント必須に改修。グラントのライフサイクル3ルート追加(`POST /tenants/:id/support-grants`、`POST /support-grants/:id/end`、`GET /support-grants/active`)。`tsc --noEmit`エラーなし。
- [x] (B) スタッフ・セッション管理・LINE接続診断 完了(2026-08-19)。新規`operations-routes.ts`に5ルート: スタッフ一覧・無効化(所属テナント外のスタッフIDは拒否・平文APIキー等を返さないことをテストで明示的に検証)・テナント全セッション失効・LINE連携状態(秘密情報は一切含めずレスポンスに`token`/`secret`という語が出現しないことをテストでアサート)・LINE接続テスト(既存の`readLineCredential`/`LineClient`/`requireLineBotUserId`を再利用、5秒タイムアウト付き)。テスト18/18成功、`tsc`エラーなし。`routes.ts`/`index.ts`は非改変(配線待ち)。
- [x] (A) ダッシュボード集計・データ整合性検査 完了(2026-08-19)。新規`dashboard-routes.ts`。プラットフォーム全体集計(テナント数/24h Webhook失敗数/未処理数/有効サポートグラント数/活動停滞テナント数)、テナント別ヘルス(LINEアカウント状態・Webhook成否・スタッフ/セッション数)、データ整合性検査5項目(孤立`tenant_line_accounts`・capability行欠落・未マッピング患者・停滞pending Webhook・`source_handoff_id`不整合)。**発見した実装上の罠2件**: (1) `pharmacy_webhook_event_receipts.received_at`はJST(`+09:00`)、`tenant_admin_sessions`/`platform_admin_access_grants`はUTC(`Z`)で保存形式が異なり、文字列比較のカットオフを別々に計算する必要があった(混同すると集計が0件または全件になる不具合を誘発するところだった)。(2) `PRAGMA foreign_keys`はリポジトリ全体で一度も設定されておらず、孤立行チェックは形式的な保険ではなく実質的な安全網であることを確認。テストは`better-sqlite3`による実DBベース(`routes.test.ts`のSQL文字列マッチ方式ではなく)、14/14成功、`tsc`エラーなし。`routes.ts`/`index.ts`は非改変。
- [x] (C) Webhook個別再試行・LINE送信一時停止・既存テスト修正 完了(2026-08-19)。`POST /tenants/:id/webhook-events/:webhookEventId/retry`(既存`runWebhookInboxEvent()`を再利用、`failed`/`dead_lettered`のみ対象)。`custom_030`で`tenants.outbound_messaging_paused_at`(nullable、CHECK制約拡張のDROP+RENAME回避のため新カラム方式)を追加、全プロアクティブ配信が経由する唯一の関数`sendPharmacyAutomatedPush()`(冪等性キー消費**前**に判定、一時停止中でも再開後に送信できるよう配慮)にゲートを実装、3箇所の呼び出し元(処方箋通知・validity・服薬フォローアップ)が新しい`'paused'`結果を誤って「送信済み」と記録しないよう修正。**自己発見・修正したバグ1件**: 一時停止APIの初稿で、存在しないテナントIDに対しても`db.batch()`のUPDATE 0件がSQLエラーにならないため監査行だけコミットされてしまう不具合(本セッションで繰り返し警戒してきたfail-openパターンそのもの)をテストで検出し、隣接するPATCHルートと同じ事前存在チェック方式に修正。`routes.test.ts`の5件の失敗はグラント発行のテストヘルパー追加(`seedGrant()`)とフィクスチャ更新で解消、グラントのライフサイクル(step-up誤りパスワード拒否・テナントスコープ・期限切れ・早期終了・パスワード変更カスケード)のテストを新規9件追加。`apps/worker`全体1619テスト成功、`packages/db`/`update-engine`もグリーン。
- [x] `index.ts`への新ルーター群(`dashboard-routes.ts`/`operations-routes.ts`)の最終配線 完了(2026-08-19、自分で実施)。`tsc --noEmit`エラーなし、`apps/worker`全173ファイル1619テスト成功を配線後に再確認。5コミットに分割してコミット済み。
- [x] フロントエンド 完了(2026-08-19)。サポートモード開始フォーム(理由・チケット番号・時間・現在のパスワード)をテナント詳細ページと、患者一覧/詳細ページが403(グラント未取得)を受け取った際のインライン画面の両方に設置(エラーページで行き止まりにせず、その場でサポートモードを開始できる導線)。共通レイアウトにグラントごとのカウントダウンバナー+終了ボタンを追加(既存の「全体管理者モード」バナーとは別に併存)。`/platform-admin`ルート(未使用だった)を7項目のダッシュボード+5件のデータ整合性バッジ表示に。テナント詳細にLINE接続状態(行ごとの接続テストボタン付き)・スタッフ一覧(無効化・全セッション失効)・送信一時停止/再開のセクションを追加。ログ画面にWebhook再試行ボタンを追加。テナント名表示は`/tenants`を毎回叩いて監査ログを汚さないよう、グラント開始時にlocalStorageへ保存したマップから解決する設計。テスト68/68成功(新規9件)、`pnpm --filter web build`成功(全8ページ含め静的プリレンダリング確認)、`tsc`エラーなし。
- [x] **最終統合検証・コミット 完了(2026-08-19)**。`pnpm -r typecheck`全パッケージエラーなし。`pnpm -r test`: line-sdk 3/3・sdk 55/55・liff 31/31・db 248/248・update-engine 215/215・create-line-harness 61/61・web 68/68・worker 1619/1619(173ファイル)、全てグリーン。`pnpm --filter web build`成功(全8 platform-adminページ静的プリレンダリング確認)。Tenant Control Center MVP一式、コミット済み。

### Tenant Control Center MVP まとめ
サポートモード(期限付きグラント・step-up再認証・理由/チケット必須・監査記録)、全体ダッシュボード、テナント別ヘルス、LINE連携状態・接続テスト、データ整合性検査5項目、スタッフ無効化・セッション一括失効、Webhook個別再試行、LINE送信一時停止/再開を実装。**未実装のまま運用チーム判断待ち**: 真のMFA(現状はパスワード再入力によるstep-upで代替、コード内コメントで明記)、全体管理者専用の別オリジンへの分離(DNS/ホスティング設定が必要でこのセッションからは実行不可能)、ロール細分化(Operator/Support/Auditor/Root)、異常検知・アラート通知。

### 外部レビュー(3回目、Tenant Control Center 仕様書に対する「条件付きNo-Go」)への対応 — 2026-08-19

前2回と同様、レビュアー自身が「対象ブランチ・コミットを参照できず仕様書のみのレビュー」と明言しているため、各指摘を**実コードで検証したうえで、さらに敵対的レビュー(各所見に対し独立した反証エージェント2体)にかけて**選別した。検証19エージェント・実装5エージェント。

**検証の結果 REFUTED(実装しない)**:
- **患者所有関係の未証明(P0-6, High主張)** → 反証成立。`patient_id`を持つ全テーブルが`pharmacy_patients(id, line_account_id, owner_friend_id)`への**複合外部キー**を宣言しており、かつ`pharmacy_patients.id`はグローバルなPRIMARY KEY、`tenant_line_accounts.line_account_id`はUNIQUE。関連行が別アカウントに属する行はそもそも挿入できず、テナント間で候補アカウント集合は互いに素。順次ループが誤った患者を返すことは構造上ありえない。性能(N+1)の話であってセキュリティの話ではない。
- **監査INSERT失敗時にPHIが漏れる(P0-5)** → 反証成立、既にfail-closed。両PHIルートとも`recordPlatformAdminAccess`を`c.json`より前に`await`しており、当該関数はエラーを握りつぶさず、アプリは`onError`ハンドラを一切登録していない。監査書き込み失敗時は500が返りPHI本文は送出されない。**ただし「テストがない=将来サイレントに壊れうる」という指摘は妥当だったため回帰テストのみ追加。**
- **同一オリジンXSSによるPHI窃取(Critical主張)** → Web全体に`dangerouslySetInnerHTML`/`innerHTML`/`eval`/動的`href`・`src`が**1件も存在しない**ことを確認。高権限画面と低信頼データ描画が同一オリジンに同居する設計懸念は妥当だが、"Critical・能動的脆弱性"と呼べる実証済みの注入シンクは存在しない。
- **`/logs`がWebhook生ペイロード(PHI)を返す** → `/logs`のSELECT列に`payload`は含まれない。またplatform-admin配下にR2バイトを配信するルートも存在しない。

**検証の結果 CONFIRMED(実装済み・コミット済み)**:
- ログアウトがサポートグラントを失効させていなかった(最大60分間PHIアクセスが生存)
- グラントが発行元セッションに束縛されておらず、同一管理者の別セッション(盗用Cookie)が相乗りできた → `custom_031`でセッション束縛
- Webhook再試行の409ガードが無効(UPDATE条件に状態述語がなく、同時実行の敗者も通過し、cron sweepが保持中のリースを解除しうる)
- スタッフ無効化がプラットフォーム全体の`staff_members`を書いており、テナントスコープのルートから全体管理者をロックアウトできた
- bootstrapの初期パスワードがHMAC決定的で、後日CLIキーを得た者がオフライン再計算可能だった → CSPRNG化 + `custom_032`で「キーのみのbootstrapは1回限り」をDB制約化
- 整合性検査がグラントなしで患者UUIDを返していた → SQLレベルで秘匿
- `Cache-Control: no-store`が全ルートで欠落 → `platformAdminAuthMiddleware`に集約(3ルーター全てを1箇所でカバー、各ルーターでヘッダ到達をテストで実証)

**副次的に発見・修正した実バグ**: `listMynaHandoffs`が`LIMIT 100`を適用した**後**に呼び出し側がJSで患者フィルタをかけていたため、繁忙アカウントでは患者本人の詳細画面からマイナ連携履歴が黙って欠落しうる状態だった(診療記録の欠落であり表示上の問題ではない)。フィルタをSQL側に移動。

**検証後の最終状態**: `pnpm -r typecheck`全パッケージクリーン、`pnpm -r test` 296ファイル/2311テスト成功、`pnpm test:scripts` 14ファイル/119テスト成功、`bootstrap.test.ts`同期確認済み。マイグレーションは`custom_001`〜`custom_032`まで重複・欠番なし。

**残る本番PHI有効化の条件(コードでは解決不可)**: 別オリジン分離、真のMFA(Cloudflare Access等)、ロール細分化。いずれもインフラ・製品判断であり運用チームの対応が必要。

---

### P0 ― リリースブロッカー

- [x] **H-3** 完了(2026-08-19)。`custom_023_pharmacy_webhook_durable_inbox.sql` で既存の `pharmacy_webhook_event_receipts` に `payload`/`status`(pending/processing/completed/failed)/`lease_until`/`retry_count`/`dead_lettered_at` を追加(新規テーブルではなく既存テーブル拡張を選択 ― テナント/アカウントスコープのPKとON DELETE CASCADEを重複させないため)。ハンドラは200応答**前**にイベント本文と`status='pending'`を書き込み、durable書き込み自体が失敗した場合は200ではなく**500**を返すよう変更(以前は失敗しても200でイベントを握りつぶしていた)。`waitUntil`は共通の`runWebhookInboxEvent()`(lease→処理→completed/failed)を呼び、毎分Cronの`sweepWebhookInbox()`(10回失敗でdead-letter、それ未満はlease切れ/未完了を再処理)が同じ関数を再利用。実SQLite+実マイグレーション+実Honoルートでのテスト7件: durable書き込み失敗時の500応答とwaitUntil未実行/isolate停止を模したpending行のsweep復旧/同一webhookEventId二重配信で副作用1回/テナントA・B同一IDで互いに独立/retry→dead-letter/パージ境界。M-1/M-7も同一バッチで完了(下記)。

- [x] **M-5 → 格上げ: High → 完了** (2026-08-19)。詳細と検証結果はP2の完了エントリを参照。

- [x] **H-2** 完了(2026-08-19)。「CAS成功時だけ副作用を`INSERT ... SELECT ... WHERE EXISTS(...)`で条件付き実行」方式を採用。verification/shadow-submission/prescription-event/myna-events全INSERTを、開始時に読んだ状態(`status`・`updated_at`)に対する`EXISTS`ガード付きに変更、handoff自身のUPDATEは同じCAS述語を保持したままbatch内最後尾に配置(先頭に置くと後続ガードを無効化するため)。**実SQLite(better-sqlite3)バックエンドでの競合テストで実証**: 修正前は同時検証2件が両方成功していたのが、修正後は1件成功・1件rejected、`pharmacy_myna_verifications`は常に1行に収束。期限切れとの競合(`expireMynaHandoffs`が読み取り後・batch前に発火)でも書き込みゼロ・handoffは`EXPIRED`のまま維持されることを確認。`apps/worker`薬局系56ファイル378テスト成功、`tsc`エラーなし。M-3/M-2も同一バッチで完了(下記)。

---

### P1 ― 要調査(未検証。着手前に自分でコードを確認すること)

外部レビューが「current-worktree レビュー」として言及した項目。2026-08-19に実コードで調査完了。結果は以下のとおり(未検証のまま鵜呑みにせず、実際に読んで判定した)。

- [x] **V-1** 確認済み・実在 → **修正実装済み**。`apps/worker/src/routes/broadcasts.ts` の `GET /api/broadcasts/:id` に `accountResourceOwnedByStaff`(`middleware/tenant-boundary.ts`)によるテナント所有権チェックを追加、不一致は404を返す(存在有無を秘匿するため403ではなく404)。テスト3件追加(`broadcasts-tenant-boundary.test.ts`: 越境→404 / 同一テナント→200 / テナント文脈なし→従来どおり200)。
- [x] **V-2** 確認済み・問題なし。`booking.ts` は全クエリが一貫して `line_account_id` でスコープされている(所有権チェックの抜けは発見できず)。クローズ。
- [x] **V-3** 確認済み・実在。`apps/worker/src/routes/tags.ts` は `getTags`/`createTag`/`deleteTag` などがテナント/アカウント引数を一切取らない。
- [x] **V-4** 確認済み・実在。`apps/worker/src/routes/webhooks.ts`(汎用の受信/送信Webhook CRUD、LINE受信用の `routes/webhook.ts` とは別物)も同様にテナント/アカウント引数が一切ない。CRUD全体(作成・一覧・更新・削除)が対象で、読み取りだけでなく他テナントのWebhook設定の削除・改ざんも可能。
- [x] **V-5** 確認済み。`packages/db/migrations/custom_014_pharmacy_logical_tenants.sql` は移行時に既存の全 `line_accounts` を無条件で `pharmacy_account_capabilities.mode='pharmacy'` にバックフィルし、かつ `apps/worker/src` 内で `INSERT INTO tenants` を行うコードパスは `custom/pharmacy/provisioning/routes.ts`(薬局テナント発行専用)の1箇所のみ。したがって「非薬局テナントが複数共存する」状態は現行の移行・発行経路からは作られず、V-1/V-3/V-4は**現状は到達不能**と判断できる。ただしこれはDB制約ではなく「移行スクリプトと発行経路がそうなっている」という規約上の保証にすぎず、将来のバグや手動DB操作で崩れうる。M-1の最終深刻度はLowに格下げ可能だが、code-level gapとしてV-1/V-3/V-4自体の修正・invariant補強は実施する。

→ **「tenant-invariant-safeguard」バッチ完了(2026-08-19)。** V-1はbroadcasts.tsを直接修正。V-5のinvariant補強については、要求していた「line_accountsにcapability行を保証するトリガー」が実は既に `custom_017_pharmacy_account_defaults.sql` の `line_accounts_default_pharmacy_capability` トリガーとして存在済みと判明(新規マイグレーションの重複作成は回避)。代わりに `packages/db/test/pharmacy-capability-invariant.test.ts`(出荷済みschemaに対する回帰テスト)と `apps/worker/src/custom/pharmacy/provisioning/tenant-insert-invariant.test.ts`(`INSERT INTO tenants` の実装箇所が`provisioning/routes.ts`の1箇所のみであることをgrepで検証する回帰テスト)を追加。テスト結果: packages/db 238件成功(既存の無関係な失敗1件のみ)/ apps/worker 1513件成功(既存の無関係な失敗7件のみ、rate-limit.test.tsのタイミング起因とmyna repository.race.test.tsの並行性タイミング起因、いずれもtenant-boundary.ts/broadcasts.tsを参照しないことを確認済み)/ packages/update-engine 205件成功(既存の無関係な失敗6件のみ)。`tsc --noEmit` エラーなし。
V-3(tags.ts)・V-4(webhooks.ts)自体のテナントスコープ化は、この時点では次回対応として保留したが、後続P7-7で`custom_034`・tenant-scoped routes・実DB越境否定テストまで実装済み。

---

### P2 ― High(継続、深刻度表現を修正)

- [x] **H-1** 完了(2026-08-19)。トークン全体をFNV-1a系ハッシュ化しクライアントIPと合成してバケットキー化(`hashToken()`、`rate-limit.ts:106-121`)。`/api/liff/pharmacy/*` を `UNAUTHENTICATED_PATTERNS` に追加しIP鍵の未認証バケット(100/min)を明示適用。TDDでRed(修正前は新規5テストが失敗)→Green(修正後 apps/worker 全168ファイル1520テスト成功、`tsc --noEmit`エラーなし)を確認。L-8(下記)も同一バッチで実施。
  - file: `apps/worker/src/middleware/rate-limit.ts`

- [x] **L-8** 完了(2026-08-19、H-1と同一バッチ)。`SENSITIVE_PATHS`を厳密一致(`/api/auth/login`のみ)と`SENSITIVE_PATH_PREFIXES`(`/api/platform/pharmacy/tenants`、`admin-bootstrap`/`credentials/{backfill,scrub,restore}`等の動的セグメントを含む子パスを前方一致でカバー)に分離し`isSensitivePath()`で統合判定。テスト2件追加、成功。

- [x] **M-5** 完了(2026-08-19)。`executeD1Query()`の境界に`assertD1Success()`を追加し、トップレベル`success!==true`と各ステートメントの`success!==true`の両方を例外化(`errors`/`messages`/`error`/`body`から詳細抽出、500文字で切り詰め)。migrations.tsの注入可能な`execute`シームもラップし、テスト用executorが本番より緩くなれないようにした。テスト追加(HTTP200+success:false契約、batch内の個別ステートメント失敗)、成功。

- [x] **M-6** 完了(2026-08-19)。**実装中に本タスクの前提の事実誤りが判明・訂正された**: `CREATE TRIGGER IF NOT EXISTS`が既存の異なる本体のトリガーと衝突した場合、SQLiteは実際にはエラーを一切出さずサイレントにno-opする(better-sqlite3で実証)。「"already exists"エラーを再分類する」という当初の指示は前提が誤りだったため、実行前にトリガー本体を比較する事前チェック(`triggerAlreadyMatches()`、`sqlite_master`から現在の定義を取得し正規化して比較、不一致ならトリガー名と両方の本体を含めて例外)に変更。指示どおり「常にDROP+CREATE」は採用していない。副次的な成果として、`migrations.ts`と`cf-api/d1.ts`の間で矛盾していたD1のトランザクション保証に関するコメントも解消(`cf-api/d1.ts`側の「1ステートメントずつ実行」という記述が誤りと判明し訂正)。テスト追加、`packages/update-engine` `tsc`エラーなし。M-5と同一バッチ。
  - **統合時に発見・修正した相互作用の問題**: このバッチのテスト実行で、M-8バッチが作成した`custom_026`(処方箋閲覧監査ログ用)がテーブル再作成(DROP TABLE + RENAME)方式でCHECK制約を拡張していたため、`packages/update-engine`の「安全なD1更新」ガード(`DROP TABLE`/`RENAME`を無条件で破壊的とみなし拒否)に引っかかり、`upgrade-matrix.test.ts`で12件失敗することが判明。これは`027_dedup_delivery.sql`(このガードが導入される前の古いマイグレーション)を誤って前例としたことが原因で、担当者(本セッション)の指示ミス。`custom_026`を、既存テーブルのCHECK制約を拡張する代わりに新規の完全加算的テーブル `pharmacy_prescription_view_events` を作る方式に書き直して解消(`repository.ts`の`recordPrescriptionFileViewed`と対応するテストも追従)。修正後 `upgrade-matrix.test.ts` 13/13成功、`bootstrap.test.ts`成功、`apps/worker` prescriptions配下94テスト成功。
  - file: `packages/update-engine/src/materialize.ts:100-107`

---

### P3 ― Medium

- [x] **M-2** 完了(2026-08-19)。`continuity/routes.ts:44-46` の `use('/api/custom/pharmacy/continuity')` を `use('/api/custom/pharmacy/continuity/*')` に変更。導入済みHono 4.12.8で `/*` が親パス自身にもマッチすることを実証済みのため登録は1本で足りる。子ルートは operations-access チェックと capability チェックの両方をすり抜けていたことが判明(想定より1段深刻)。テスト2件追加(capability無効→403、権限外アカウント→403。修正前はいずれも201が返っていた)、成功。

- [x] **M-1** 完了(2026-08-19、H-3と同一バッチ)。`scenarios`テーブルには`tenant_id`が存在しなかった(nullable `line_account_id`のみ)ため、`custom_024_scenario_tenant_scope.sql`で`tenant_id`列を追加しバックフィル(アカウント紐付き行は所属テナントを継承、アカウント未紐付き行はテナントが1つしかない場合のみ帰属させ、複数テナント環境では`NULL`のまま=どのテナントにもマッチしない設計)。`getScenariosForAccount(db, lineAccountId)`を新設し、テナント解決はSQL側で`tenant_line_accounts`から行うため呼び出し元の`tenantId`引数の取り違えでスコープが広がることもない。webhook.ts/routes/scenarios.tsの呼び出し元を更新、JS側フィルタは削除。テスト4件追加(2テナントでの未紐付きシナリオ相互不可視・fail-closed・バックフィル)、成功。V-5の調査で到達不能と確認済みだが、防御多層性として実装。
  - **後続対応済み**: `apps/worker/src/routes/liff.ts` の同型箇所はP7-6で`getScenariosForAccount()`へ移行し、null accountをSQL helperでfail-closed化した。2026-08-20のFUP-SCOPE-1ではroute側に残っていた冗長な`!matchedAccountId`許可も否定テスト付きで削除し、helper回帰時にもaccount-bound scenarioをenrollしない二重防御へ整理した。

- [x] **M-3** 完了(2026-08-19、H-2と同一バッチ)。継続フォロー(`linkContinuitySubmission`/`completeContinuityAfterClose`/`pausePatientContinuity`)とマイナ(`markMynaLaunchRequested`/`recordMynaPatientReport`)の状態UPDATE+監査イベントINSERTを単一`db.batch`に統合。イベントINSERTは「UPDATE後の状態」を条件にした`INSERT ... SELECT ... WHERE`へ書き換え、UPDATEが不発(0件)でも孤立イベントが生まれない構造に変更。構造的テスト追加(UPDATE/INSERTがそれぞれ`operation: 'batch'`で発行されることをアサート)、成功。
- [x] **M-4 / L-3** 完了(2026-08-19)。`custom_025_pharmacy_tenant_integrity_v2.sql` を新規作成し、`pharmacy_prescription_submissions.source_handoff_id` が同一 `line_account_id` の `pharmacy_myna_handoffs` を参照することをINSERT/UPDATE双方でトリガー検証(custom_022と同スタイルの`RAISE(ABORT, ...)`)。L-3は調査の結果、`pharmacy_prescription_files`/`_events` の `submission_id` は既に `REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE` のネイティブFKで保護済みと判明(`foreign_keys=ON`で存在しないIDへのINSERTが実際に失敗することを実証)、追加のトリガーは不要と判断し migration ヘッダーコメントに記録。テスト5件追加、対象5ファイル16テスト成功。`bootstrap.sql`/`bootstrap-meta.json` 再生成済み(ただし他バッチのマイグレーション追加により最終統合時に再生成が必要 ― 下記「運用メモ」参照)。
- [x] **M-7** 完了(2026-08-19、H-3と同一バッチ)。`purgeWebhookEventReceipts()`を追加し、`status='completed'`または`dead_lettered_at IS NOT NULL`かつ30日超の行を削除、`pending`/`processing`はどれだけ古くても削除しない。6時間毎Cronで実行。テスト(29日/31日境界、`pending`は400日でも保持)成功。
- [x] **M-8** 完了(2026-08-19、修正版)。当初 `custom_026_pharmacy_prescription_view_events.sql` は `pharmacy_prescription_events.event_type` CHECKを`027_dedup_delivery.sql`の前例(テーブル再作成方式)に倣って拡張していたが、**M-5/M-6バッチの検証で`packages/update-engine`の安全なD1更新ガードが`DROP TABLE`/`RENAME`を無条件拒否することが判明**(`027_dedup_delivery.sql`はこのガード導入前の古いマイグレーションで前例として不適切だった)。既存テーブルのCHECK拡張ではなく新規の完全加算的テーブル `pharmacy_prescription_view_events`(id, submission_id, file_id, staff_id, viewed_at)を作る方式に本人が書き直して解消。`recordPrescriptionFileViewed()`とテストも追従。修正後 `upgrade-matrix.test.ts` 13/13・`bootstrap.test.ts`・`apps/worker` prescriptions配下94テストいずれも成功。「監査ログがないと全件通知になる」という表現は「不正閲覧時の影響範囲特定能力の欠如」に言い換え済み。
- [x] **M-9(バケット分離のみ)** 完了(2026-08-19、本人が直接実施)。`apps/worker/wrangler.toml` のデフォルト環境R2バケット名を `line-harness-images` → `line-harness-images-dev` に変更し本番と明示的に分離。**フィールドレベル暗号化は本タスクの対象外として意図的に見送り** ― `answers_json`等への暗号化適用は既存の`line-credential-store.ts`パターンを応用する設計だが、復号鍵管理・クエリ性能・既存データの移行方針を伴う独立した設計検討が必要なため、「実装」ではなく次回スプリントでの設計タスクとして別途起票すること。
- [x] **M-10 / L-1** 完了(2026-08-19)。M-10: `resolveAuthenticatedTenant`のバイパス分岐に `[auth] accept_via=LEGACY_ENV_OWNER_BYPASS tenant=<id>` ログを追加、`docs/ADMIN-AUTH.md`に廃止条件(監査期間ゼロ件確認後に廃止可)を明記(`LEGACY_API_KEY`側にも前例がなかったため本ドキュメントが両者のパターンを確立)。L-1: `auth.ts`(API_KEY/LEGACY_API_KEY)・`line-proxy.ts`・`packages/line-sdk/src/webhook.ts`の非定数時間比較をすべて置換。既存の`sameText`ヘルパーを`auth.ts`/`line-proxy.ts`で再利用、依存ゼロ方針の`line-sdk`パッケージには専用の`constantTimeEqual`をローカル実装(誤った「定数時間比較は不要」というコメントも削除)。`line-sdk`にvitestテスト基盤がなかったため新規セットアップ。テスト追加、`line-sdk` 3件・`apps/worker` 認証/line-proxy関連88件成功、`tsc`エラーなし。フルスイートで見えた失敗は他バッチ(webhook.ts, continuity/routes.ts)の作業中差分に起因すると確認済み。

---

### P4 ― 法令遵守(要事業・法務判断。コードだけで違反を断定しない)

外部レビューの指摘どおり、「違反を確認した」という表現は取り下げ、「コード/フォーム上では証跡を確認できない」という証跡不足の表現に統一する。

**2026-08-19: このセクションは当初「PLANS.mdの未実装タスクを実装」の対象から意図的に除外した。** 理由: H-4/H-5/H-6はいずれも個人情報取扱事業者の所在・薬剤師法上の保存義務との整合・保存期間の3つの未解決の経営/法務判断(要判断事項1・2)に従属しており、その判断なしにコードだけで「実装」すると、間違った前提(例: 削除すべきでないデータを削除する、削除すべきデータを保持し続ける)で本番に影響するおそれがある。要判断事項2の文言修正(条番号訂正)のみ、法務判断を要しない単純な誤字修正なので直接反映した。

**2026-08-20: 要判断事項1・2をユーザーに確認し、結論を得た。** 個人情報取扱事業者=各テナント(薬局)、法定保存範囲=処方箋画像・問診回答・マイナ連携データ・LINEメッセージを含む全PHIを一律3年間(薬剤師法施行規則の調剤録・処方箋保存期間を準用)。この結論を前提にH-4/H-5/H-6を実装した。

- [x] **H-4** 完了(2026-08-20)。詳細はH-4コミット(`feat(pharmacy): tenant-owned privacy notice + policy version on consent`)参照。表示主体は各薬局(個人情報取扱事業者)、プラットフォームは受託者と明記。`custom_036`でテナント別の利用目的・問い合わせ窓口・委託関係・policy version/hashを保持し、問診同意時点のバージョンを相関サブクエリで記録。
- [x] **H-5** 完了(2026-08-20)。詳細はH-5コミット(`feat(pharmacy): PHI retention matrix + prescription-image purge job`)参照。`docs/custom/pharmacy/RETENTION_MATRIX.md`で全PHIを3年一律のretention classに分類、R2 lifecycle実機確認は引き続き`NOT_RUN`(Cloudflare account IDがplaceholderのため)。削除実装は処方箋画像(R2+`pharmacy_prescription_files`)のみ今回着手、それ以外(患者テーブル本体・LINEチャット画像・JST時刻混在テーブル等)はmatrix内で次回タスクとして明示。
- [x] **H-6** 完了(2026-08-20)。詳細はH-6コミット(`feat(pharmacy): data-subject request workflow with DB-enforced legal hold`)参照。`custom_038`で開示・訂正・利用停止・消去請求の受付〜本人確認〜legal hold判定(3年基準をDB CHECK制約で強制)〜結果記録までを実装。実際のPHI削除自体はH-5のpurgeパス側の責務として分離。
- [x] 要判断事項2の文言修正(条番号の誤りを訂正、法務判断不要のためこの行自体で完了): 「問診データ・処方箋画像は薬剤師法27条の調剤記録に該当するか」→「問診回答・画像・LINEメッセージのどの部分を、**薬剤師法27条(調剤済み処方箋の保存)・28条(調剤録の保存)**その他の業務記録として正式保存するか」

---

### P5 ― Low / Hardening

- (L-1 → 完了。M-10と同一バッチで対応済み、上記P3参照)
- [x] **L-2** 完了(2026-08-19)。`listNextIntakeExpectations(db, accountId, friendId?)` を `listPatientExpectations(db, lineAccountId, friendId)`(必須)と `listAccountExpectations(db, lineAccountId)` の2関数に分割、SQL断片は共有ヘルパーで重複排除。患者向け/スタッフ向け両ルートの呼び出し元を更新。テスト追加、成功。
- (L-3 → 完了。M-4と同一バッチで対応済み、上記P3参照)
- [x] **L-4** 完了(2026-08-19)。`custom_027_pharmacy_staff_api_key_hash.sql` で `staff_members.api_key_hash` を追加(平文`api_key`列は後方互換のため維持、破壊的変更なし)。新規シークレット `STAFF_API_KEY_HASH_SECRET` を採用(`LINE_CREDENTIAL_KEY_V1`は薬局スコープ・ローテーション前提のため不適切と判断、既存キーとの衝突チェックも実施)。`getStaffByApiKey()` はハッシュ照合→レガシー平文照合の順にフォールバックし、平文一致時に機会的にハッシュを自動バックフィル(D1書き込み失敗時も認証は失敗させない設計)。シークレット未設定でも従来どおり平文照合で動作し、無停止でロールアウト可能。テスト5件追加、`packages/db` 244件成功・`tsc`エラーなし、`apps/worker` 認証関連124件成功。`.env.example` への `STAFF_API_KEY_HASH_SECRET` は後続コミット `b4a5ec9` で追記済み(`docs/CUSTOMER_DELIVERY.md`も同期済み)。
- [x] **L-5** 完了(2026-08-19)。`bootstrap-tenant-admin.ts`/`setup-tenant.ts`のHMACメッセージにテナント識別子(tenant id / tenant code)を追加(`pharmacy-tenant-admin-bootstrap:{tenantId}:{idempotencyKey}`等)。同一テナント+同一idempotency-keyでの冪等性は維持しつつ、異なるテナント間での初期パスワード衝突を解消。テスト追加(同一テナント→同一パスワード、異なるテナント→異なるパスワード)、成功。
- [x] **L-6** 完了(2026-08-19)。`rich-menus.ts`の`resolveLineClient`に`accountResourceOwnedByStaff`(既存ヘルパー再利用、再実装せず)による独立したテナント所有権チェックを追加。非所有アカウントは既存の「not found」相当のフォールバック(デフォルトのLINE_CHANNEL_ACCESS_TOKENクライアント)に扱いを統一。上流ガードをバイパスして直接呼び出す形のテストを追加し、単独でも越境を防ぐことを実証。
- [x] **L-7** 完了(2026-08-19)。`PrescriptionPage.tsx`の`startResubmission`から`setOriginalConsent(true)`/`setNoticeConsent(true)`を削除。`canSubmitPrescription`が両同意を要求する既存ロジックはそのままのため、再提出時に「再度チェックしてください」という一行のヒントUIを追加。テスト追加(jsdom未導入のためソースコード契約テスト方式)、成功。
- (L-8 → 完了。H-1と同一バッチで対応済み、上記P2参照)
- (L-9 → 完了。M-8と同一バッチで対応済み、上記P3参照)
- [x] **L-10** 完了(2026-08-20、専用の別枠で実施)。詳細はコミット`chore(deps): update dev toolchain dependencies (L-10)`参照。vitest 2→4・vite 6→8・wrangler 4.77→4.124等をdevDependenciesのみ更新(production dependenciesは無変更)。vitest 4のモック構築子(`new`呼び出し)・`restoreAllMocks`のspy限定化・testTimeout厳格化に伴うフォールアウトを個別修正、アサーションは一切緩めていない。`typescript` 5→7・`@cloudflare/workers-types` 4→5(hono 4との型不整合)・`tailwindcss` 4.2→4.3(出力CSS変更を伴う)は意図的に見送り。`pnpm -r build`/`typecheck`/`test`/`test:scripts`全てグリーン。

---

### P6 ― レビュー手法・証跡整備(次回監査のため)

- [x] **E-1** レビュー対象のhead SHA / base SHA / merge-base / dirty statusを固定して記録する運用にする
- [x] **E-2** ルート網羅表(method + path + auth principal + tenant source + guard + repository関数)を作成する
- [x] **E-3** DB網羅表(全tenant-owned tableのtenant列・FK・UNIQUE・NULL許否・R2参照)を作成する
- [x] **E-4** バックグラウンド処理(webhook/Cron/Queue/retry/booking/broadcast/webinar/notification)の横断監査を別枠で実施する(V-1〜V-5を含む)
- [x] **E-5** 否定テスト行列(Aの資格情報 × Bの全resource type)をテストスイートとして整備する
- [x] **E-6** R2 lifecycle設定・prefix別retention・dev/prod分離状況を取得して記録する(`SECURITY_REVIEW_EVIDENCE_2026-08-19.md`。live lifecycleはCloudflare account IDがplaceholderのため`NOT_RUN`と明記)
- [x] **E-7** サマリ文の言い換え。旧: 「テナント間・患者間の情報漏洩は確認されなかった」→ 新: 「テスト対象とした薬局LIFF4系統では、別テナント/別患者のPHIをread/writeできる経路を再現しなかった。ただしrepository全体のtenant isolationは未確立であり、generic CRUD・broadcast・background delivery等はP1(要調査)完了まで未確定として扱う」

### P7 ― 機能改善バックログ(ultracode 6-stream discovery + UI/UX deep audit、2026-08-19)

`fix/dev-pharmacy-line-account-provisioning` ブランチ上で6テーマ(①薬局ID短縮 ②テナント分離攻撃 ③UI改善 ④LIFF UX ⑤LIFF新機能 ⑥PLANS.md未実装棚卸し)を並列調査し、さらにUI/UXは薬局管理画面11画面+全体管理者4画面+横断6レンズの専用監査(46 agents)を追加実施した。isolationの生19件は全件を3人のrefuterで独立検証(2/3以上の反証で却下)、UI/UXの生181件は重複排除後上位28件を検証(26件が実在確認)。ワークフロー実行ログは `.claude/projects/-Users-yusuke-workspace-pharmacy-harness-line/d2bb381b-7688-4f23-989b-6e633a452a7b/subagents/workflows/{wf_e16ce0f2-ed0,wf_424c0a2a-7e1}/journal.jsonl` に保存済み(再開時はここを読めば再調査不要)。

**① 薬局ID短縮 ― 完了・コミット済み(`b817fcf`)。** 6桁ランダム数字をサーバー側で発行(`crypto.getRandomValues`によるrejection sampling)。ログインは薬局コード+管理者ID+パスワードの3点照合かつ行なしでもdummy hash比較のためコードは秘密情報ではなく列挙対象にならない。既存の長いコードはログイン経路に形式チェックを追加していないため引き続き有効。全角IME入力はNFKC正規化で吸収。

**サイドバーメニュー修正 ― 完了・コミット済み(`1372ae7`)。** ユーザー指摘の「メニューに出ていない機能」は `/notifications`(未対応)だった。復元したallowlistは同時に、削除していた `isPharmacyMenuPath` を復活させ、薬局テナントに一般CRMメニュー22項目が403の行き止まりとして出ていた問題(UI/UX監査で発見)も解消。

- [x] **P7-1(推奨・最優先)** 破壊的操作の安全化 ― critical/high の destructive + silent-failure 群を一括修正
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionDetailPanel.tsx:151` / `PrescriptionQueuePage.tsx:150` ― 「受け渡し完了」「準備完了にする」等が無確認・取り消し不可でLINE送信まで実行される(critical)。`shouldConfirmAction`(`PrescriptionQueuePage.tsx:42-44`)が `danger` フラグのみで判定しており、`close`/`accept`/`ready`/`request_resubmission` は未確認。修正時は `danger`(色)と確認要否を別フラグに分離すること(`danger`をcloseにも付けると緑の完了ボタンが赤に変わり判別性が悪化する、と検証agentが指摘済み)。サーバー側 `state.ts` に `closed` からの遷移が無く、UIの取り消し不可は実際にAPIレベルでも取り消せないことを意味する。
  - [x] `apps/web/src/app/accounts/page.tsx:183,390` ― LINEアカウント有効/無効トグルに確認・エラー処理・二重送信防止が無い(critical)。誤操作で患者からのLINE受信が全停止する。
  - [x] `apps/web/src/app/emergency/page.tsx:98` ― 緊急停止が失敗しても「完了」バッジを表示する(critical)。最も危険な誤情報。
  - [x] `apps/web/src/custom/pharmacy/myna/MynaAdminPage.tsx:116` ― マイナ確認8ボタンが確認なし一発で不可逆確定(high)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionPrintPage.tsx:98` ― 印刷ダイアログをキャンセルしても「印刷操作済み」を記録でき、再印刷手段がない(high)
  - [x] `apps/web/src/custom/pharmacy/medication-followup/MedicationFollowUpPanel.tsx:171` ― 終端状態への遷移ボタンが確認なし・取り消し不可・タップ標的24px(high)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx:222,139` / `apps/web/src/contexts/account-context.tsx:78` / `apps/web/src/app/accounts/page.tsx:177` ― アクション失敗・画像取得失敗・アカウント取得失敗・削除失敗のエラーが無言または画面の遠い場所にしか出ない(high、計4件)
  - [x] `apps/web/src/custom/pharmacy/activity-notifications/PharmacyActivityNotificationsPage.tsx:76` ― 「確認済みにする」が確認なし・取り消し不可で行を消す(medium)

- [x] **P7-2** データ誤読・表示不備の修正
  - [x] `apps/web/src/custom/pharmacy/prescriptions/FulfillmentQuoteEditor.tsx:40` ― 準備予定時刻・有効期限が再表示時にUTCのまま9時間ずれる(high。DBがJST `+09:00` とUTC `Z` を混在保存している既知の罠、`PLANS.md` の過去のダッシュボード実装メモ参照)
  - [x] `apps/web/src/custom/pharmacy/continuity/ContinuityAdminPage.tsx:160` ― 継続フォロー一覧に患者識別情報が一切ない(critical)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx:166` ― 「受付する」失敗時に「ほかのスタッフが先に更新しました」と誤診断される(high)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PatientIntakeAdminPage.tsx:83` ― 遷移後の再取得にレース対策が無く、別患者の回答が表示される可能性(high)
  - [x] `apps/web/src/custom/pharmacy/medication-followup/MedicationFollowUpPanel.tsx:32` ― 「キャンセル」ラベルが画面離脱ではなく患者フォローの永久取消を意味する(medium、文言のみ)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/FulfillmentQuoteEditor.tsx:118` ― 英語の内部ステータスがそのまま露出(low)

- [x] **P7-3** 全体管理者(platform-admin)画面の修正 ― PHIの信頼性に直結
  - [x] `apps/web/src/components/platform-admin/support-mode.tsx:172` ― 通信エラーでサポートモードバナーが消え、記録中の特権セッションに気づけない(high)。support modeは「操作者が自分が記録中の特権セッションにいると常に自覚できる」ことをUI要件としてP7内で最優先扱いにすること。
  - [x] `apps/web/src/app/platform-admin/tenants/patients/detail/page.tsx:79` ― 「終了」しても期限切れになっても、表示中の患者PHIが画面に残り続ける(high)
  - [x] `apps/web/src/app/platform-admin/tenants/detail/page.tsx:129,274,292` ― Webhook再試行が確認なしで患者へのLINE送信を再実行/送信一時停止パネルが現在状態を表示せず確認・二重送信防止もない(high、計2件)
  - [x] `apps/web/src/app/platform-admin/layout.tsx:54` ― セッション確認失敗を全部握りつぶしてログイン画面へ飛ばす(high、API障害時に原因不明)

- [x] **P7-4** LIFF(患者側)UX改善 ― 17件確認済み、優先度が高いもののみ抜粋(残りは `whfy5hdne.output` / `journal.jsonl` 参照)
  - [x] `apps/liff/src/custom/pharmacy/prescriptions/PrescriptionPage.tsx:133` ― 2枚目の写真撮影が1枚目を無言で削除する(small、複数ページ処方せんで再現)
  - [x] `apps/liff/src/custom/pharmacy/prescriptions/PrescriptionPage.tsx:146` ― 再送信時に再チェックした同意欄・希望受取時間が失われる(medium。既存の `L-7`(同意チェックの自動オン廃止)と地続きの未完了フォロー)
  - [x] `apps/liff/src/custom/pharmacy/intake/PatientIntakePage.tsx:44` ― 半分入力した問診票がリロード/戻る操作で消える(medium)
  - [x] `apps/liff/src/custom/pharmacy/myna/MynaReceivePage.tsx:106` ― マイナ外部ウィンドウから戻ると結果パネルが消える(large)
  - [x] `apps/liff/src/custom/pharmacy/request.ts:28` ― APIエラー時に英語の生文字列がそのまま患者に見える(medium、根本原因は `apps/web/src/lib/api.ts` の `fetchApi` がサーバーエラーメッセージを握りつぶしていること。P7-1と共有原因の可能性、先にそちら側を直すと波及して直る)

- [x] **P7-5(⑤の回答)** LIFFに追加すべき新機能 ― AI/OCR・マーケットプレイス・重複ドメインモデル禁止(AGENTS.md)を満たす形で選定済み、6件
  - [x] 受付状況カード(準備予定時刻・確認事項の見える化) ― `PrescriptionPage.tsx:282` 拡張、small
  - [x] マイナ受付の進行中セッション復帰 ― `MynaReceivePage.tsx:19` 拡張、small(P7-4のセッション消失問題と表裏)
  - [x] 受け取り希望(時間・方法)の申告と変更 ― `apps/worker/src/custom/pharmacy/prescriptions/routes.ts:302` 拡張、medium
  - [x] アンケート「前回から変更なし」ワンタップ更新 ― `PatientIntakePage.tsx:175` 拡張、small
  - [x] 服薬フォローアップのLIFF回答画面 ― 完了(2026-08-19)。既存3択回答と同じ状態機械を再利用し、LINE所有者・`line_account_id`・capabilityでfail-closedにスコープしたLIFF一覧/回答APIと患者画面を追加。PHIなし通知から認証済みLIFFへの導線、非評価的な回答文言、緊急時119案内、確認・二重送信防止を実装。薬局側は要対応を先頭表示し、患者回答を`担当/優先確認 → 対応済み → 完了`まで閉じる前に記録する遷移へ修正。
  - [x] 来局しました(到着通知) ― `apps/worker/src/custom/pharmacy/prescriptions/repository.ts:510` 拡張、medium

- [x] **P7-6(⑥のうち追加で判明した分)** `liff.ts:916` の `getScenarios(db)` 修正は3箇所の同型呼び出し漏れとセットで行うこと。単独修正すると兄弟箇所が壊れたまま残る。
  - [x] `apps/worker/src/routes/friends.ts:573`
  - [x] `apps/worker/src/services/friend-tag-attach.ts:49`
  - [x] `apps/worker/src/routes/scenarios.ts:197`
  - 変更後は `liff-oauth-scenario-gate.test.ts` / `liff-friend-add-scenarios.test.ts` がnullアカウント時の現行挙動を固定しているため、意図的な仕様変更として更新すること(黙って通すよう緩めない)。

- [x] **P7-7(残作業の棚卸し、⑥の残り)**
  - [x] `.env.example` に `STAFF_API_KEY_HASH_SECRET=` を追記
  - [x] `apps/worker/src/routes/tags.ts` / `webhooks.ts` へのtenant scopeカラム追加(V-3/V-4、`custom_034`と実DB越境否定テストを追加)
  - [x] field-level encryption設計ドキュメント作成(M-9フォローアップ、`answers_json`等が対象)
  - [x] E-1〜E-7(レビュー証跡整備、次回監査用)
  - [x] `PLANS.md:103` のH-3フォローアップ注記を削除(`platform-admin/routes.ts:434-500`・`platform-admin/logs/page.tsx:102-131`で実装済みと確認済み)

- [x] **P7-8(2026-08-19追記 ― 初回記入から漏れていた分)** P7作成時、workflow2の深掘り監査(pharmacyAdmin/platformAdminバケット)は全件転記したが、①それと同一file:lineで別カテゴリとして生き残った1件、②workflow1のサーベイ段階の指摘(workflow2は対象外だった画面横断チェック)、③complete­ness critic(監査自体が見落とした領域)の3種を転記し忘れていた。以下で補完する。

  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx:150` ― 「キャンセル」確認ダイアログが患者へLINE通知が飛ぶこと・取り消し不可であることを説明せず、「キャンセル」という語自体がダイアログを閉じる意味にも読めるため誤ってOKしやすい(high, P7-1と同一バッチで直すこと)
  - [x] `apps/web/src/custom/pharmacy/medication-followup/MedicationFollowUpPanel.tsx:114` ― フォロー予約成功時に失敗と誤表示され、そのまま再試行すると重複予約が作られる(causes-error)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionReviewEditor.tsx:49` ― 発行者を保存すると、薬剤師が直前に入力した有効期限欄が無言で消える(causes-error、データ消失)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx:96` ― 「LINEで通知しました」の緑バナーが次の処方せんに引き継がれ、実際には通知していない案件を通知済みと誤認させる(causes-error)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueueOverview.tsx:85,120,125` ― ステータスタブの件数が読み込み済み50件のみで集計される/初回フェッチ前から「該当なし」を描画する/キュー行に患者を特定する情報が一切ない(blocks-task、3件セット)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionQueuePage.tsx:132` ― 画像を高速にページ送りすると古いリクエストが後着ちして誤った患者の画像が表示されうる(blocks-task、レース条件)
  - [x] `apps/web/src/custom/pharmacy/myna/MynaAdminPage.tsx:116` ― 確認待ちキューが読み込み中でも「確認対象なし」と表示される(causes-error、empty-vs-loading)
  - [x] `apps/web/src/custom/pharmacy/intake/PatientIntakeAdminPage.tsx:129` ― 患者履歴の取得に失敗すると「読み込み中」のまま永久に固まる(slows-task、:83のレース問題とは別件)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionPrintPage.tsx:66` ― 一度「確認」した後は再印刷する手段がない(blocks-task、:98の「キャンセルしても記録される」問題とは別件)
  - [x] `apps/web/src/custom/pharmacy/prescriptions/PrescriptionImageViewer.tsx:36` ― `aria-modal` を宣言しているがフォーカスを移動・トラップしない(a11y, low)
  - [x] `apps/web/src/lib/api.ts:145` ― セッション切れ(401)をその場で検知せず、以後の操作が汎用エラーのまま作業不能になる(blocks-task)
  - [x] `apps/web/src/app/page.tsx:426` ― 薬局テナントでもアカウント読み込み中は一般CRMダッシュボードが一瞬表示され、6本の403リクエストが飛ぶ(slows-task)
  - [x] `apps/web/src/app/login/page.tsx:39` ― ログイン失敗時にサーバーの内部エラー文字列がそのまま薬局スタッフに表示される(slows-task)
  - [x] `apps/web/src/app/friends/page.tsx:52` ― 友だち管理のタグ絞り込みが薬局テナントでは常に空になる(slows-task)
  - [x] `apps/web/src/app/page.tsx:232` ― 一般ダッシュボードのデモ用バナーがプレースホルダURLのまま残っている(cosmetic, low)

- [x] **P7-9(completeness critic が指摘した横断的な未調査領域、2026-08-19追記)** 実コード再調査と確認された不具合の実装を完了。
  - [x] 薬局アカウントが0件の新規薬局: account読込完了まで待ち、0件時はアカウント設定への導線だけを表示。一般CRM APIを起動しない。
  - [x] `fetchApi`: 500文字以内の構造化detailを保持し、401はブラウザ状態を消去して即時ログインへ遷移。患者向け/ログイン画面は内部文字列を直接表示しない。
  - [x] 複数スタッフ操作: CASを使う処方せんと服薬フォローで409時に最新状態を再取得し、競合と再操作方法を説明。
  - [x] 全体管理者の送信一時停止: `line-accounts`応答へtenant状態を追加し、薬局コンソール全画面に「患者向けLINE送信一時停止中」バナーを表示。
  - [x] 「停止」の意味: platform-adminを「患者向けLINE送信」、Growth Loopを「能動的なお知らせの月間上限」と明記。緊急コントロールは薬局メニューから除外済み。
  - [x] `PrescriptionImageViewer`: pointer dragによるパンを追加し、拡大・回転後も任意箇所を確認可能にした。
  - [x] キュー・詳細: `status`/`submission`をURLへ同期し、リロード/共有リンクで復元。状態タブは発見した追加バグ(先頭50件だけの絞り込み)も既存server-side `status` filterへ接続して修正。
  - [x] 印刷タブ同期: 印刷元がfocusへ戻ったとき、現在の詳細を再取得して印刷確認状態を同期。
  - [x] 緊急コントロール: 調査の結果、薬局メニューから既に除外され、実効停止は`outbound_messaging_paused_at`を共通senderが全薬局通知前に検査していた。追加の偽ボタンは作らず、上記バナーで状態を可視化。
  - [x] 共有タブレット: logout/401でCSRF・スタッフ表示・選択アカウントを消去。
  - [x] `mustChangePassword`: ログイン画面で既存sessionを復元し、途中リロード後も初回パスワード変更フォームへ戻す。

- [x] **P7-10** workflow2の残り141件をseverity順にjournalと現行file:lineで再照合し、実在した安全性・誤認・操作不能・アクセシビリティ問題を修正。重複、既修正、主観的レイアウト提案、内部エラーを患者/薬局へ露出すべきという安全境界と逆行する案、処方せん画像欠落時も印刷を続ける案などは実装対象から除外した。
  - [x] **フォローアップ関連14件の実在確認と修正(2026-08-19)**: `MedicationFollowUpPanel` は過去日時の予約拒否、対象処方せんの識別、状態別の実時刻、送信前プレビュー、行単位busyを追加。患者LIFFは対象カード強調、状態別時刻、行単位busy、失敗時再取得/再読込を追加。`ContinuityAdminPage` は実送信日時と、staff・account scope・version CAS・監査イベント付きの予約取り消しを追加。親の患者画面はloading/error/emptyを分離し、JST表示と内部英語ラベルを修正。関連テスト: Worker 10 files/38 tests、Web 5 files/20 tests、LIFF 3 files/8 tests成功。
  - [x] **隣接する薬局運用画面の実在確認と修正(2026-08-19)**: activity通知のpoll/ack競合とエラー消失、Growth Loopの月・薬局切替時の旧集計表示と発行元取得失敗の誤表示、Myna期限切れ受付を正式に「使用期限外」と記録できない問題を修正。表示時刻をJSTへ統一し、タップ領域と用語も整理。
  - [x] **残る非フォローアップ指摘の実在確認と修正(2026-08-19)**: チャット送信失敗、ヘルス取得不能の正常誤表示、ダッシュボード部分失敗、全体管理ログ/監査/テナント健全性、特権操作の確認とsingle-flight、狭幅テーブル/モーダル/タップ領域/キーボード操作、内部エラー露出、JST表示、検索/絞り込み/ページ分割を修正。テナント一覧はWorker側で未解消Webhook失敗とLINE設定不足を集約し、1件ずつ開かずに障害を特定可能にした。検証: Web 27 files/139 tests、Worker follow-up/continuity/platform-admin 11 files/80 tests、LIFF follow-up/continuity 2 files/6 tests成功、`git diff --check`成功。

### P8 - 緊急避妊薬の来局前確認 Phase 1 MVP - 2026-08-19 実装計画

**調査根拠と境界**: 添付仕様421行を全文確認し、厚生労働省「[緊急避妊薬の調剤・販売について](https://www.mhlw.go.jp/stf/kinnkyuuhininnyaku.html)」(令和8年4月7日更新)および「[緊急避妊薬を調剤・販売する薬剤師及び販売する薬局・店舗販売業の店舗について・令和8年3月31日一部改正](https://www.mhlw.go.jp/content/11120000/001683896.pdf)」を一次情報として再確認した。今回のコード対象は、LINEを入口にした**来局前確認・仮受付・薬剤師レビュー**まで。販売可否の自動判定、オンライン販売、配送、代理受取、事前決済、製品別独自完全問診、メーカー紙チェックシートの電子置換は実装しない。店頭で研修修了薬剤師が最新メーカーシートを使って最終判断する。

- [x] **EC-0 外部human gateをfail-closedで表現**
  - [x] 薬局番号、研修修了薬剤師、単一取扱製品、メーカー公式セルフチェックURL、プライバシー確保、飲料水、連携先、利用目的/問い合わせ先/保存期間が揃うまで患者受付を公開しない。
  - [x] コード上の準備完了と厚労省一覧掲載・実在庫・実勤務を別の主張として扱い、未確認時に「購入可能」「販売可」「服用できます」を表示しない。
  - **受入条件**: 必須設定の欠落または販売枠の条件欠落時、患者APIとLIFFが受付不能理由と電話/直接相談の代替導線だけを返す。

- [x] **EC-1 additive schemaと機微情報保護**
  - [x] `custom_035` に account-scoped settings / trained pharmacist / service slot / inventory / provisional intake / immutable event を追加し、全query/mutationを`line_account_id`でスコープする。
  - [x] 患者入力は性交日時、本人来局、面前服用、年齢帯、安全連絡方法、同意versionのPhase 1最小項目だけにし、自由記載・病歴・月経・性暴力詳細・画像を取得しない。
  - [x] 性交日時をapplication-layer AES-GCMで暗号化し、ログ・例外・通知・患者一覧projectionへ平文を出さない。暗号鍵未設定時はfail closed。
  - [x] pending仮受付にTTLを持たせ、期限切れ・取消・店頭対応不成立で在庫枠を解放する。患者所有権とstaff/account authorizationの否定テストを追加する。
  - **受入条件**: 別テナント/別患者read-write不可、重複送信冪等、在庫1件への同時仮受付は1件だけ成立、保存行とログに平文性交日時が存在しない。

- [x] **EC-2 72時間・例外フラグの純粋ロジックをTDD**
  - [x] 推定服用時刻を枠開始時刻ではなく説明時間を加えた時刻として計算し、性交後72時間を超える枠は提示しない。時刻不明は当日00:00を用いた保守判定とし、結果は`risk_flags`で薬剤師へ送るだけで最終`eligible`を保存しない。
  - [x] 16歳未満、16-17歳、3か月2回以上、本人来局不可、面前服用不可、通知不可を人レビュー用フラグとして扱い、自動販売不可にはしない。ただし代理受取/オンライン完結は仮受付を成立させない。
  - **受入条件**: 71時間30分+30分説明、日跨ぎ、時刻不明、過去/未来日時、複数回利用、期限直前の境界テストがRed-Greenで固定される。

- [x] **EC-3 患者LIFF**
  - [x] 未チェック同意 -> 約60秒で完了できる最小確認 -> 対応枠選択 -> メーカー公式セルフチェック導線 -> 仮受付番号の順に進む。内部ナビゲーションは現在の`liffId`を保持する。時間依存の受診を遅らせる人工的な待機は設けない。
  - [x] 通知安全性を患者が選択でき、画面・通知とも薬名/性交/妊娠を露出しない中立表現にする。期限超過・枠なしは薬局返信待ちにせず厚労省の販売薬局一覧と受診案内を表示する。
  - [x] 二重送信防止、送信中、競合、再試行、期限切れ、取消をキーボード/モバイル双方で扱えるようにする。
  - **受入条件**: LIFFコンポーネント/APIテストで同意未取得、72時間超過、在庫競合、成功、取消、内部エラー非露出を確認する。

- [x] **EC-4 薬局管理画面**
  - [x] 必須設定、研修修了薬剤師、販売枠、在庫数を管理し、公開可否と欠落条件を1画面で確認できるようにする。
  - [x] 仮受付を期限/緊急度順に表示し、患者申告を「未確認」と明示する。レビュー済み、取消、期限切れ、店頭対応完了をCAS付きで記録し、販売可否自体は紙の最新メーカーシートへ残す。
  - [x] 取消・店頭対応完了・在庫変更は確認ダイアログ、single-flight、成功/失敗表示、監査イベントを持つ。
  - **受入条件**: account切替時の旧データ消去、別account拒否、競合再取得、空/読込/失敗状態、狭幅表示、キーボード操作をテストする。

- [x] **EC-5 配線・回帰・リファクタリング**
  - [x] Worker/LIFF/Webのroute・sidebar・API client・bootstrap metadataを最小差分で配線する。既存のLIFF identity、staff account guard、JSON parser、暗号化、JST表示、CAS/idempotencyパターンを再利用する。
  - [x] 実装で見つけた共通バグは共有関数の根本で修正し、無関係な全ファイルの整形や新規依存追加は行わない。
  - [x] 関連Worker/LIFF/Web/DBテストと`git diff --check`を最終編集後に再実行する。
  - **受入条件**: EC-0〜EC-4の要件別証跡を本節へ追記し、local code/test greenとproduction operationを混同しない。
  - **実装証跡(2026-08-19)**: Worker 5 files/66 tests、DB 1 file/12 tests、LIFF 3 files/13 tests、Web 3 files/7 tests、LIFF TypeScript build、`git diff --check`が成功。`custom_035`とbootstrap metadataを生成済み。厚労省一覧掲載、実在庫、当日の研修修了薬剤師勤務、メーカー紙記録運用、デプロイ、本番動作は未確認であり、human gateのまま。

**外部Human Gate・明示的スコープ外**:
- Myna `tenant_alias` のグローバルユニーク衝突(low, `endpoint-repository.ts:148`)と `/r/myna/:tenantAlias` 未認証URL開示(low, `myna/routes.ts:184`)は今回のisolation調査で唯一生き残った2件。優先度lowのため今バッチには含めず次回起票。
- H-4/H-5/H-6は後続P4で方針確定・実装済み。ただしR2 lifecycle実設定とP8の厚労省一覧掲載・実在庫・当日勤務・メーカー紙運用・deployment/production動作はコード外Human Gateのまま。
- E-7は完了済み。E-6は証跡文書作成済みだが、live R2 lifecycle確認だけはCloudflare account IDがplaceholderのため`NOT_RUN`を維持する。

## Done

- [x] 2026-08-19: マルチテナント化差分(`v0.26.0/feature/logical-multitenancy`)の初回セキュリティレビュー実施、Artifact/Markdownで報告(High 6 / Medium 10 / Low 10)
- [x] 2026-08-19: 外部レビュー(REQUEST_CHANGES)を受領。技術指摘を実コードで検証し本計画に反映。`GET /images/:key` 無認証PHI漏洩の指摘は実コード確認(`apps/worker/src/routes/images.ts:103-119`)により却下、その他の妥当な指摘(D1 batch()挙動・isolate非共有・薬剤師法条番号・APPI文言)は反映済み
