# 担当別完全受入記録 — audit-v5-20260928

Status: source integration済み、検証BLOCKED/PARTIAL。以下は担当提出時点の記録。親Iの最終判定は監査記録を参照。

# Worker / DB / shared / LINE SDK audit acceptance record

Run: audit-v5-20260928 / owner: /root/worker_audit / 2026-09-28

## 実行面・snapshot・権限
- 主担当からread-only監査を受領後、WA-01とWA-02だけ実装許可。再帰spawnなし。
- 子モデル/推論の実効値は取得不能。親の設定との同一性を断定しない。
- 元repo: `/Users/yusuke/workspace/pharmacy-harness-line`、H=B=`6fa678b5df61ec78176e040cfeb8b8ca54ed9055` clean。元repoのsource/index/branch未変更。
- 実装root: `.git/audit-v5-20260928/auth`、branch `audit/v5-20260928-auth`。作成は親。実装前rootとclean状態を確認。
- インストール前package scripts/vitest config/pnpm-workspaceを読取り。`pnpm install --offline --frozen-lockfile --ignore-scripts` exit 0、503 packages local cache reuse、download 0。install scripts実行なし。
- node経路はv26.6.0、pnpm出力11.25.0、Hono導入source4.13.5。外部設定/秘密値は読んでいない。
- agent-defaults、jevgrep、security-audit skillを適用。security-auditの実行隔離要件でdynamic validationがBLOCKED。

## WA-01 FIX / CONFIRMED_BUG (source path), P0候補 / BLOCKED (検証)
- 入力P: `6fa678b5df61ec78176e040cfeb8b8ca54ed9055`。
- W: `7e149c8`。親統合Iは別commit `aecbba3` (親通知、子がintegration成功を代弁しない)。
- 条件: 無認証HTTPリクエストのAPI prefixをpercent encode (`/%61pi/templates`)。Hono routerは`getPath`でdecodeURI、auth middlewareはraw pathnameをAPI外としてskip。tenantIdなしでtenant guardsもskipし、template routeはundefined scopeをDBに渡す。
- 証拠: `apps/worker/src/middleware/auth.ts:authMiddleware`、導入Hono `dist/utils/url.js:getPath`、`index.ts` middleware順序、`routes/messaging/templates.ts`、`packages/db/src/templates.ts:getTemplates/updateTemplate/deleteTemplate`。tenantId undefinedはWHERE条件省略なので全tenantのtemplates読取/更新/削除経路に到達する。コード上の境界違反を確定、HTTP実行/本番reachabilityは未検証。
- 原因: routerとauth/policyが異なるpath表現を信頼。
- 変更path: middleware/auth.ts、auth.test.ts、custom/pharmacy/growth-loop/generic-feature-guard.tsと.test.ts、custom/pharmacy/platform-admin/auth.ts、auth-path.test.ts。
- 修復: 5 policy decision sitesをHono `c.req.path`へ統一。route正規化を別helperで再実装しない。
- 保持契約: 正常pathの認証/tenant membership/CSRF/method例外/薬局allowlist/platform admin分離/Cache-Control/公開form readを保持。API field/routes/export/schema/migration不変。意図差分はencoded aliasにcanonical routeと同じ認証・認可を適用すること。
- 回帰追加: auth.test.ts 8 cases（prefix3種とpath segment、staff+tenant identity、public formのGET/PUT/DELETE、real worker template routeがstorageに達する前に401）。platform auth-path.test.ts 5 cases（canonical/encoded loginとprotected sessions、no-store）。generic guard 1 case+既存mixed-install testへencoded QRを追加。既存test削除/skip/期待値弱化なし。
- 検証: `git diff --check` exit 0。sandbox-exec下のvitestは開始不能、Red/Green/typecheck/build/consumer runtimeは未実施。期待される修正前Redは未観測でありPASS/VERIFIEDにしない。
- patch: `WA-01.patch`（git staged binary diff、全6path/new fileを含む）。修正前test-only patch: `auth-red-tests.patch`。
- 統合注意: 親I上でsource差分検証と全関連auth/tenant/capability testsを改めて実行。patchとcommitを二重適用しない。

## WA-02 FIX / CONFIRMED_BUG (source + first-party contract), P2 / BLOCKED (検証)
- 入力P: `7e149c8`。W: `5445c61`。親通知の統合I commit: `a50427d`（統合検証は親が管理）。
- 条件: LINE broadcast/multicastが受理済みretry-keyで409、`x-line-request-id`（retry request）と`x-line-accepted-request-id`（original send）が異なる。
- 証拠: `packages/line-sdk/src/client.ts:LineClient.request/multicast/broadcast`。409を成功扱いしながらretry request IDを返し、worker `services/broadcast.ts:441-442`→db `updateBroadcastLineRequestId`→worker `services/insight-fetcher.ts:32`→`getMessageEventInsight`が誤IDを使う。
- 一次仕様: https://developers.line.biz/en/docs/messaging-api/retrying-api-request/ （2026-09-28閲覧）。再試行ごとにrequest IDは変わり、409時のaccepted headerが初回受理IDと明記。併せて https://developers.line.biz/en/reference/messaging-api/nojs/ のresponse header仕様を確認。
- 影響: 再試行から成功扱いへ復旧したbroadcastのanalytics相関が壊れる。配信重複を新規に発生させるfindingではない。
- 原因: HTTP attempt IDとaccepted operation IDの取り違え。
- 変更path: `packages/line-sdk/src/client.ts`, `packages/line-sdk/test/client.test.ts`。
- 修復: private `acceptedRequestId`でaccepted header優先、無ければ従来request header。multicast/broadcastで意味が同じ2つの読取りを統一。
- 保持契約: public method signature/export/import path、返却 `{ data, requestId }` shape、通常200 request ID、409 `retryAccepted`、header absent時fallback/null、送信headers/body/pathは保持。型緩和なし（test fixtureのheaders unionをRecordにcastするだけ）。
- 回帰追加: 2 methods × 5 cases（200、409両header、acceptedのみ、requestのみ、両方無し）計10。既存tests削除/skipなし。
- 検証: `git diff --check` exit 0。runtime Red/Green、typecheck、SDK build/package importはsandbox blockerにより未実施。
- patch: `WA-02.patch`。source export/manifest/module分割は変更していないがSDK package consumer smokeは未実施。
- 統合注意: WA-01後をPとする独立2path patch。親I上でSDK suiteおよびworker broadcast/insight testsが必要。承認済み送信に対するID相関の期待差分だけである。

## 検証blocker・再開条件
- skill `/Users/yusuke/.codex/skills/security-audit/SKILL.md` のUniversal execution safety: OSによるnetwork禁止、環境allowlist、read-only source、scratch-only writes、CPU/memory/process/file/disk/wall上限が必要。`If every control cannot be enforced, do not execute target code`。
- HOME変更を禁じる上位指示があるためenv -iでHOME未設定、TMPDIR/XDG_CACHE_HOMEのみscratchへ設定した。
- 最初の準備試行: `ulimit -u 64`は既存265processに対して低すぎ、timeout forkがexit125。上限350にして後続を試行。
- 試行コマンド骨子: `timeout 90 env -i PATH=<node+system> TMPDIR=<scratch> XDG_CACHE_HOME=<scratch> NODE_OPTIONS=--max-old-space-size=512 sandbox-exec -f <profile> node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts --root apps/worker src/middleware/auth.test.ts --maxWorkers 1 --no-file-parallelism --no-cache`。
- 結果exit134/出力なし。`sandbox-exec ... node --version`と`... /bin/echo sandbox-check`もexit134。対象testは未到達。host sandboxの起動制約かprofile不足かは未確定、OSがsandboxを適用したという証拠もない。自動承認拒否の表示はなかった。
- 証拠profileは `.git/audit-v5-20260928/auth-sandbox-evidence/test.sb`。scratchはcommitしない。制限無しの別経路へ迂回せず親へ報告、親がblocked記録を承認。
- 再開: 要件を満たす既存sandbox基盤を利用可能にし、P+test-only差分のRed、WのGreen、Iの統合・package checksと独立reviewを実行する。環境の作替え/権限緩和/実サービス試行はしていない。

## 調査対象・semantic search
- local candidate inventory: worker 529 TS、db（schema/migrations/tests含む）173 TS/SQL、shared src3TS、LINE SDK src6TS。生成distをsourceと混同しない。
- jg対象: worker middleware（auth/tenant/rate-limit）、custom/pharmacy/retention（deletion intents/fence/recovery/preflight）、line-sdk/src（request/retry/signature）、db/src（tenant scope helpers/transactions）。送信前にsource候補のsecret/private-key/email等をlocal確認、混在candidateがあるworker全域/sharedは送信せず、上記安全subtreeだけ使用。
- jg result: middleware11files、retention7files、SDK3files、DB30files。source byte budgetによる抜粋省略を含み、全件coverageの証拠とはしていない。重要結果を直接sourceと照合。middleware/retentionのtool outputはtruncated部分があり、直接readしたsymbolのみ評価。
- shared/sticker.tsのcandidateは`sticker@2x.png`による誤検出と直接readで判明（外部送信なし）。他のcandidate file本文は必要なく読んでいない。

## C01-C12 coverage（子の担当scope全体としての評価）
|領域|評価|実確認・未確認|
|---|---|---|
|C01|PARTIAL|auth/policy経路、5箇所path表現、LINE SDK helper重複とcallerを確認。他の巨大repository/routeの責務分離未評価。|
|C02|PARTIAL|LINE retry request相関とJST util、webhook follow/retry経路、retention UTC/fence条件を読取。全業務遷移/医療計算は未確認。|
|C03|PARTIAL|durable webhook claim/heartbeat/claim-token CAS、outbound operation+payload batch、DSR version/epoch、retention tombstone前後を読取。全mutations/queue consumerは未被覆。|
|C04|PARTIAL|migrations inventoryとbootstrap方式を確認。旧custom_023/custom_038 pathは現baselineへ統合されておりコメント参照のみ残る。適用/rollback/row保全実行はなし。|
|C05|PARTIAL|WA-01の入口→auth→tenant bypass→DBまで静的確認と修復。staff role/session/API token tenant resolution、pharmacy assignment/policyを直接確認。暗号・全LIFF所有者経路は未評価。|
|C06|PARTIAL|LINE error body固定化、webhook bounded body/30d receipt retention、incoming image ownership/hold/hashed identity/tombstone経路を読取。暗号backfill/export等未被覆。|
|C07|PARTIAL|WA-01/02の影響public契約はsource確認。全API/CLI/pagination/runtime validationは未評価。|
|C08|PARTIAL|worker client/render UIは未確認。患者/管理web担当へ委譲範囲外、worker SSR/forms等は残る。|
|C09|PARTIAL|webhook max1MiB、sweep50/attempt10/stale24h、outbound replay100、LINE fetch timeout無しを確認。実負荷/計算量全般未評価。|
|C10|PARTIAL|durable inbox dedup/retry/lease、outbound retry24h-margin、retention outcome unknown/reconcileを読取。全failure interleavingは未検証。|
|C11|PARTIAL|該当regression追加・既存assertion保持をsourceで確認。全suite未実行。|
|C12|PARTIAL|scripts/hooksは親確認+package config直接照合、offline ignore-scripts install成功。test startup blocked、typecheck/build未実施。|

## X追加探索の適用判断
|領域|適用|評価・理由|
|---|---|---|
|X01|適用|PARTIAL: Worker/SDK配布あり。親が配布担当、子SDK成果物smoke未実施。|
|X02|適用|PARTIAL: lockfile/offline install/hooks有り。親がsupply chain/CI担当。|
|X03|適用|PARTIAL: retention/DSR/recovery/R2 lifecycleの一部を追跡。restore/export/全derived copies未確認。|
|X04|適用|PARTIAL: LINE signature/inbox/idempotencyとoutbound retryを追跡。Calendar/Stripe等未確認。|
|X05|適用性一部|PARTIAL: worker同梱clientがある。offline/tab lifecycle未確認（情報不足なのでN/Aにしない）。|
|X06|適用|PARTIAL: repoにMCP packageあり（親担当）。worker内部agent tool権限は未探索。|
|X07|適用|PARTIAL: 医療・算定・相談業務。規則変更なし。制度一次資料との照合は未実施。|
|X08|適用|PARTIAL: public assets/OG/LIFFフォーム/webhookあり。認証境界一部のみ評価。|

## Module coverage
以下のREVIEWEDは示した責務だけの静的評価であり、runtime PASSや全repo監査完了を意味しない。
|module/範囲|評価|根拠/未被覆|
|---|---|---|
|worker middleware/auth + tenant-boundary + role-guard + rate-limit|REVIEWED (静的)|full sourceまたは重要全経路を読取。WA-01発見。CSRF、membership、resource ownership、role fail-closed、rate limit pathを照合。dynamic未実施。|
|worker custom/pharmacy/growth-loop/access + generic-feature-guard + account|REVIEWED (静的)|active tenant/membership/assignment、allowlist、manual-chat capability経路。shared staff schema fallbackを確認。|
|worker platform-admin/auth|REVIEWED (path/session gating静的)|独立cookie、login exemption、CSRF、must-change-password gating。credential/password発行全経路は別module未被覆。|
|worker routes/messaging/templates,message-templates + db/src/templates,message-templates|REVIEWED (tenant静的)|route→optional scope helper→SQLを追跡。WA-01 blast radius根拠。|
|line-sdk/src/client,webhook,errors|REVIEWED (静的)|HMAC署名、constant-time compare、fetch/request/error/retry ID、全public client methods source読取。WA-02。timeout concernは未採択。|
|shared/src/sticker|REVIEWED (静的)|serialize/parse、URL ID encoding、fallbackを読取。shared/types914行はPARTIAL。|
|worker index.ts|PARTIAL|middleware順/route一覧、notFound/OGのpath用途、cron wiring一部確認。cron各handler全経路未確認。|
|worker routes/integrations/webhook|PARTIAL|durable store→claim/heartbeat→handler→settle→sweep/purge、follow処理を読取。message/postback全分岐は未完。|
|worker services/outbound-line-delivery,broadcast,insight-fetcher|PARTIAL|prepare/batch/retry horizonとrequest ID保存→analytics consumerを確認。全send/settle/reconcile分岐未完。|
|worker custom/pharmacy/retention|PARTIAL|execution proof、fence/DSR overlay、deletion intents、incoming purge前後、preflight digestを読取。reconcile全分岐と実D1/R2未検証。|
|worker custom/pharmacy/data-subject-requests|PARTIAL|tenant/account scoped list/read、event/version/hold-epoch CAS初期部分を確認。医療保持判定・全transition未確認。|
|worker routes/crm/friends,chats,inbox, admin/line-accounts,staff|PARTIAL|route-level二重認可、account assignment、tenant scope、serializer等を確認。全handler未確認。|
|db/src/reminders,utils|PARTIAL|account/active mapping scope, JST/date helpersを確認。reminder全write未確認。|
|db/schema+migrations|PARTIAL|inventoryのみ、migration実行なし。|
|line-sdk messages/types/index|PARTIAL|public入口構成のみ、message builder全validation未確認。|

### 残module（列挙のみ、すべてPARTIAL）
- `apps/worker/src/custom/pharmacy`: activity-notifications/, beta-membership/, chat-templates/, continuity/, data-subject-requests/, emergency-contraception/, fulfillment/, growth-loop/, intake/, medication-followup/, myna/, patient-timeline/, platform-admin/, prescriptions/, print/, privacy-policy/, provisioning/, public-profile/, recovery/, retention/, rich-menu/。上表に明示された経路以外は未被覆。
- `apps/worker/src/routes`: admin/, booking/, crm/, integrations/, liff/, marketing/, messaging/。上表に明示された経路以外は未被覆。
- `apps/worker/src`: client/, custom/, lib/, middleware/, routes/, services/, utils/。上表に明示された経路以外は未被覆。
- `packages/db/src`: account-settings.ts, ad-platforms.ts, affiliate-attribution.ts, affiliate-links.ts, affiliate-offers.ts, affiliate-report.ts, affiliates.ts, auto-replies.ts, automations.ts, broadcasts.ts, calendar.ts, chats.ts, conversions.ts, entry-routes.ts, forms.ts, friends.ts, health.ts, index.ts, line-accounts.ts, message-templates.ts, mileage.ts, notifications.ts, reminders.ts, rich-menus.ts, scenario-resolve.test.ts, scenario-resolve.ts, scenario-schedule.test.ts, scenario-schedule.ts, scenarios.ts, scoring.ts, staff.ts, stripe.ts, tags.ts, templates.ts, tracked-links.ts, traffic-pools.ts, users.ts, utils.ts, webhooks.ts, webinars.ts。上表に明示された経路以外は未被覆。

## 有限hotspotと保全指標
- 採択FIXに付随する意味統一: WA-01 policy path解釈5箇所のraw URL参照を0へ。個別decode helperは作らずrouterの既存pathを共有。public API/export/schema差分0、既存test削除0。性能/token/LOC削減は主張しない。
- WA-02 accepted request ID選択の意味が同じ2箇所をprivate helper1つへ。送信HTTP call数と公開shape不変（静的）、追加test10、削除test0。source LOC +7で機能保全優先。
- OPTIONAL_IMPROVEMENT未採択: authMiddlewareの公開経路判定が約180行の関数へ集中。predicate分離を行う場合、ルート×method判定表で同値確認し、middlewareのbranch数/公開例外追跡箇所を実装前に固定して比較すべき。サイズだけの分割は採択していない。
- EVIDENCE_BASED_CONCERN未採択: LineClient fetchはAbortSignal/timeoutなし。outbound/inbox consumerが外部応答待ちでlease/time budgetへ影響する可能性。具体的なstalled reproducible failureとbounded timeout仕様は未確認なのでbug扱いしない。
- EVIDENCE_BASED_CONCERN P3相当未採択: authenticated unknown encoded API pathはindex.notFoundHandlerのraw pathnameでAPI JSON404ではなくSPA fallbackとなり得る。auth修正後の認証迂回ではない。CORSのraw LIFF path判定はencoded aliasを拒否する方向で権限拡大なし。metadata/canonical alias UX以外の重大影響は未確認。

## 再探索・残条件
- WA01の新規同原因の重大経路は静的再探索では検出せず。`index.ts`、`middleware/*`、`custom/pharmacy/platform-admin/auth.ts/settings-scope.ts`、`growth-loop/generic-feature-guard.ts`のpath-policyを確認。role guardはpath非依存、rate-limit/tenant-boundaryは元からc.req.path。
- WA02 caller chain `broadcast.ts`→`db/broadcasts.ts`→`insight-fetcher.ts`→SDKを再確認。multicast consumerはaggregation unitで統計を取る経路もあり、影響範囲を全送信として過大評価しない。
- 重要未確認: runtime Red/Green、B/W/I必須tests、SDK package smoke、全remaining modules、全migration保全、独立レビュー（親担当）。COMPLETE条件未達。
- 当子は自身の2commit/patchとこの記録を返却。thread close機能は子toolにないため、closeしたと主張しない。worktreeを削除していない。


---

# client-audit — audit-v5-20260928 (進行中)

- owner/thread: /root/client_audit。再帰spawnなし。モデル/推論は親継承（実効モデルID・reasoning値を取得する専用機能なし、変更なし）。
- H=B=P: 6fa678b5df61ec78176e040cfeb8b8ca54ed9055。元checkout clean を開始時確認、元コード変更なし。
- skills: agent-defaults, jevgrep 読了。web/liff AGENTS 読了、wiki概要照合。秘密値/実データ/本番接続なし。
- jg: web/src/custom/pharmacy, liff/src/custom/pharmacy, mcp-server/src を自然言語検索。ソースpath列挙/credential候補検査0、ソースおよび合成fixture対象。各検索exit0。長い出力は表示上truncateされ、候補を直接読んで追跡。SDK/plugin-templateは直接読取り。

## Findings

CL-01 CONFIRMED_BUG P2: SDK createStepScenario の未完成scenario有効化。
- 成立: 複数step構築途中でtrigger又はstep追加/parseDelay失敗。
- 経路: packages/sdk/src/workflows.ts:25 create(name,trigger) → worker/routes/messaging/scenarios.ts:257 isActive default true → packages/db/src/scenarios.ts:getFriendScenariosDueForDelivery is_active=1 → worker/services/step-delivery.ts:getScenarioSteps/complete/send。
- 不変条件: complete scenario のみactivate。対照実装mcp-server/tools/create-scenario.ts:99-113/plugin-template/src/notify.ts ensureTagAddedScenarioはdraft→steps→activate。
- 根因: SDK convenience workflowのみ段階作成中のinactive制御欠落。
- 状態: 親採択FIX SDK-CL01、専用sdk worktree P clean確認済。署名/公開export/戻り値/step順を保持、途中activeだけ意図差分。回帰/局所test/build未実施。

CL-02 CONFIRMED_BUG P1: EC管理の別受付への臨床入力持越し。
- 成立: 同account内Aの詳細を開きsaleDraft（本人確認/妊娠検査/面前服用/説明等）やmismatchDraftsを編集し、Bの詳細を開く。
- 証拠: apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx:596 loadIntakeDetail はselectedDetailのみ切替、626でsaleDraftはexpectedVersionだけ置換。mismatch reset はaccount effect:383のみ。
- 影響/根因: 患者固有下書きをaccount単位stateで共有。submitSale:676のspread/confirmSection:646のmismatchがBへ誤記録可能。CAS expectedVersionはBなので防止されない。
- 状態: 親へ早期通知済、修正未実施。保持: 同一受付でのrefresh時入力保全、別受付切替時は初期化、遅い応答も別受付へ復活させない。実DOM操作によるA→B/再読込/遅延応答回帰が望ましい。

## Coverage (暫定)

| module | status | 根拠/残り |
|---|---|---|
| web auth/account/api/app-shell | PARTIAL | HttpOnly+CSRF、strict staff session parse、accountキーremount、platform別cookie/header、safe-next呼出を確認（helper本体未精査）。実ブラウザは後掲CL02経路のみ |
| web EC admin | REVIEWED | config/list/detail/counter/sale/state切替を読取り、CL-02。後続server path確認は親へ |
| web prescription queue/print/review | PARTIAL | jg+selection generation、URL resource cleanup候補。全編集入口/print完全追跡は未完 |
| web intake/myna/continuity/medication | PARTIAL | jgでaccount guard/epoch確認、全mutation/draft境界未完 |
| web growth/settings/public-profile/privacy/DSR | PARTIAL | api scope/selectedAccountRef/confirmation/CAS読取り、全フォームruntime未完 |
| web generic CRM | PARTIAL | module列挙、AppShell共通保全。個別画面多数未精査 |
| web platform-admin | PARTIAL | api/support grant banner失効経路確認、全tenant patient UI未精査 |
| LIFF init/shell/menu/request/draft | PARTIAL | id token、author+liff+patient draft scope、TTL/legacy非読出、feature gating、固定safe routes、HTTP error privacy確認 |
| LIFF intake/prescription/EC | PARTIAL | operation idempotency/epoch/consent fingerprintを実読取り、全フォームDOM/分岐未完 |
| LIFF medication/continuity/timeline | REVIEWED | load/response state/confirm/retry/unknown routesの全コード読取り。timelineはepoch無しの同一user内古い結果懸念、実証未実施 |
| LIFF generic booking/event/webinar/affiliate | PARTIAL | 存在と薬局build未使用契約、個別実装未精査 |
| SDK client/http/resources/workflows | PARTIAL | public exports/tenant header/account routing/timeout/manual idempotency、CL-01。一部resources本体と全API server endpoint照合は未完 |
| MCP tools/resources/client/api-call | PARTIAL | jg全tools+rich-menu confirmation/pinned account+manual send+summary/errors実読取り。generic mutating tool全契約/timeout未完 |
| plugin-template | PARTIAL | 全4source cron→sync→notify→SDK経路確認。webhookはTODOだが現状JSON parseのみでbusiness mutation無し。MCP template未読 |

## Domains (担当範囲)
C01 PARTIAL（finite hotspot候補EC責務集中、採択未定）; C02 REVIEWED主要patient状態/API; C03 PARTIAL client idempotency/DB consumerのみ; C04 NOT_APPLICABLE担当にmigration無し; C05/C06 PARTIAL auth/PHI主経路、generic全確認不足; C07 PARTIAL公開SDK/MCP/api境界、全endpoint未照合; C08 PARTIAL全browser未実施; C09 PARTIALbounded retry/SDK timeout、全resource測定無し; C10 PARTIALasync race/partial creation; C11 PARTIALtest読取りのみ; C12 PARTIALpackage scripts/manifests/build config読取り。
X01適用PARTIAL（npmSDK/MCP/静的UI）; X02適用PARTIAL（manifest/hook確認、来歴license依存未完）; X03適用PARTIAL（draftTTL/印刷/DSR）; X04適用PARTIAL（LINE/plugin/SDK）；X05適用PARTIAL（LIFF WebView/offline/reconnect、native FFI無し）；X06適用PARTIAL（MCP）；X07適用PARTIAL（EC患者記録CL-02、制度変更しない）；X08適用PARTIAL（公開LIFF/薬局profile、安全URL）。

## Verification / artifacts
初期は読取りのみでtest未実施。SDK worktree /Users/yusuke/workspace/pharmacy-harness-line/.git/audit-v5-20260928/sdk, branch audit/v5-20260928-sdk。W/commit/patchは未作成。親統合未完。UI変更なし、全監査COMPLETEは未達。

## Packet SDK-CL01 完全受入記録
- FIX / owner client_audit / scope packages/sdk/src/workflows.ts, tests/workflows.test.ts。P=6fa678b5、W=b76e39a（branch audit/v5-20260928-sdkに保存）。未統合。
- 期待差分: createStepScenarioをinactiveで作成し、全step追加成功時だけactivate、その後get。step追加/activation例外はそのまま伝播、失敗時削除なし（調査/修復可能）。公開署名/export/step内容/step順/成功時active/最終get戻り値は保全。
- 修正前同条件: pnpm --filter @line-harness/sdk test tests/workflows.test.ts => exit1 / 3 fail,4 pass（active残存true、activation未実施、create入力にinactive無し）。
- 修正後: pnpm --filter @line-harness/sdk test => exit0 / 13 files,58 tests pass。pnpm --filter @line-harness/sdk typecheck =>0、build =>0（ESM index.mjs22.67KB/CJS24.33KB+d.ts）。biome format対象2files=>0、git diff --check=>0。Node26.6.0/pnpm11.25.0。
- install: pnpm install --offline --frozen-lockfile --ignore-scripts exit0、503 packages reused/download0。scripts/hook/settingsは親確認+SDK manifest/tsup/tsconfigを局所再確認。
- 残り: 親Iで統合検証、独立review。npm packed artifact隔離smokeは未実施（exports/manifest/分割変更無し）。実LINE/本番API未接続。
- CL02先行依存なし、同worktree次P=b76e39a、SDK変更と別commit予定。

## Packet UI-CL02 完全受入記録
- FIX / P=b76e39a / W=be8934f（親がCL01後に適用）。Owner client_audit、worktree sdk、branch audit/v5-20260928-sdk。変更pathは apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx と apps/web/e2e/emergency-draft-scope.e2e.ts のみ。
- 期待差分: 下書きownerをintakeIdへ紐付け、別受付開始時saleDraft+mismatchDraftsを初期値へ。取得済counter/saleもすぐ破棄。detailRequestGateで古い詳細/確認/販売の応答・error/finallyを無効化。全体/queue refreshとaccount teardownで無効化。
- 保持契約: 同じ受付のrefresh後に下書きを維持。API path/payload/expectedVersion/人のconfirm/action buttons/public exports不変。ユーザーが別受付を開く行為だけが前受付下書きの終了。schema/migration無し。
- 修正前Red: pnpm --filter web test:e2e e2e/emergency-draft-scope.e2e.ts => exit1、B本人確認unverified期待に対しdocument（A入力）を実DOMで再現。同A再読込保持は成功。初回はChromium未導入で起動失敗、次回はtest selector exact labelの誤りを修正（製品欠陥の証明として数えない）。
- 検証環境: Node26.6.0,pnpm11.25.0,Next16.3.4,Playwright1.62.1+公式chromium-headless-shell v1234。pnpm --filter web exec playwright install chromium --only-shell =>0（公式CDN公開依存物94.7MiB）。APIは全て合成stub、外部originへのrequestはabort/検査、real data/Workerなし。shared build tsc=>0。
- 修正後局所: web EC component/api vitest =>0（2 files,10 tests）。web tsc --noEmit =>0（最終E2E変更後も確認）。最終E2E =>0（1 test,11.7s）、A編集→同A refresh保持→B slow counter/sale取得中のA確認バッジ非表示/臨床初期値→取得完了後初期値→B確認/販売payload確認まで。git diff --check=>0、biome format=>0。
- lint補足: biome check対象2files exit1、既存div aria-label useAriaPropsSupportedByRole 1件（Pの1535行、W1557行）。今回変更行ではない。P stdin biome実行は一般的なcontents arent fixed診断だけで同症状確定不可、元clean Bで同command read-only比較中。lint合格とは主張しない。
- source LOC: SDK workflows83→86、UI EC1763→1785（既存API型/関数/export保全）。今回FIXのためLOC削減/性能改善は主張しない。E2E137行追加。有効な既存test削除/skipなし。
- artifact: source commit be8934f、専用branch refで保全。next-env.d.tsはNext devがimport引用符だけ生成変更したことを照合してPへ復元、git status clean、4311 listener無しを確認。
- 未実施/残り: 最終I web build/全suite/独立reviewは親担当。実LINE・本番・実患者検証未実施。UI screenshotの視覚評価は行わず実DOM/操作/送信payloadを検証。旧Worker互換はAPI契約不変・既存API unit pass、異version配備は未実施。

## 探索の締め
- CL01後consumer再照合: apps/worker/src/routes/integrations/webhook.ts:639 friend_add+is_active→enroll→pushImmediateFirstStep、DB is_active gateと整合。
- CL02後再探索: 全setSaleDraft/setMismatchDrafts/setSelectedDetailと同componentのcounter/sale読書きを照合、別受付持越しの同一原因をsale/mismatch/confirmation displayに統合。新たな確定bugなし。
- 未採択改善候補: EC admin設定/薬剤師/在庫/枠/臨床記録の責務集中。現状1763行のmain component（変更後1785）だが分割に実DOM保全必要。指標候補は臨床下書きowner責務を1moduleへ、公開helpers互換維持/requests順序/同A入力保全を保全指標。今回はサイズ単独の理由で採択せず。
- EVIDENCE_BASED_CONCERN: MCP apiCall/account-summary直fetchにAbortSignal timeoutがなく（SDK HttpClientは30s）、外部応答停止時のtool待機上限未確認。未確定・未採択。
- 全体coverageは上記PARTIALを保持。generic CRM全ページ・MCP generic全mutation・全browser/配布物/依存license/オフラインOS差は未完であり、COMPLETEを主張しない。

- B比較確定: 元clean checkout（6fa678b5）で read-only `pnpm exec biome check apps/web/src/custom/pharmacy/emergency-contraception/EmergencyContraceptionAdminPage.tsx` => exit1、同じ useAriaPropsSupportedByRole/1535行div aria-label/1errorを再現。Wの既存lint欠陥はBと同症状/同原因。追加修復はしていない。
