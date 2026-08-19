# Plans

## Active

### 前提・検証メモ
- 対象: `pharmacy-harness-line` ブランチ `v0.26.0/feature/logical-multitenancy`(ローカルチェックアウトで確認。HEAD SHA固定は E-1 で対応)。
- 2026-08-19: 元のセキュリティレビュー(Artifact/MD)に対し外部レビュー(REQUEST_CHANGES)を受領。指摘のうち検証可能なものは実コードで裏取りした上で本計画に反映した。盲信も無視もしていない。
- **検証して却下した指摘**: 「`GET /images/:key` が無認証で処方箋・マイナ・着信チャット画像を配信している」という主張は、実コード(`apps/worker/src/routes/images.ts:103-119`)と矛盾するため却下。`/images/:key` は `PUBLIC_IMAGE_KEY` 正規表現(裸UUID.ext または `tenants/{id}/uploads/{uuid}.ext`)にマッチするキーのみ配信し、着信チャット画像のキー形式(`tenants/{id}/accounts/{id}/incoming/{id}.ext`)はこれにマッチしない。着信画像は別ルート `GET /api/images/:key`(:112-119)を通り、`canReadIncomingImage` でテナント所有権を検証してから配信される。外部レビュー自身が「GitHub上で指定ブランチを参照できず、main/dev(v0.25.0相当)で照合した」と明言しており、対象ブランチの差分に起因する誤指摘と判断。H-5「アクセス制御は正しい」の所見は維持する。
- **妥当と判断し反映した指摘**: D1 `batch()` はSQLエラー時のみロールバックし、UPDATEが0件マッチしても「失敗」扱いにならない(→H-2の修正方針を再設計)。Cloudflare Workersはisolate間でモジュールグローバル状態を共有する保証がない(→H-1の深刻度表現を修正)。薬剤師法の条番号誤り(27条/28条)。個人情報保護法(APPI)関連所見は「違反確定」ではなく「コード上の証跡不足」に言い換える。
- **未検証のまま計画に組み込んだ指摘**: 外部レビューが言及した「current-worktree レビュー」(broadcasts/booking/tag/generic webhook の越境所見)は、本セッションでは原文・対象コードともに未確認。裏取りせずタスク化はできないため、P1に調査タスクとして計上した(V-1〜V-5)。
- 2026-08-19: V-1〜V-5を実コードで調査完了(結果はP1参照)。M-9(R2バケット名のdev/prod分離)を直接実施済み。P0/P1/P2/P3/P5の残タスクは、ファイルが重複しない10バッチに分けて`executor`エージェント(一部opus)へ並列実装を委任し、実行中。完了したエージェントから順にAGENTS.md/CLAUDE.mdのTDD規約に沿って変更内容・テスト結果を検証し、本ファイルのActiveから除去してDoneへ移す。
- **運用メモ(マイグレーション番号衝突)**: 並列実行の副作用として `custom_023_pharmacy_staff_api_key_hash.sql`(L-4バッチ)と `custom_023_pharmacy_webhook_durable_inbox.sql`(H-3バッチ)が同一番号で衝突していたのを検知し、前者を `custom_027_pharmacy_staff_api_key_hash.sql` へリネームして解消した。最終的に `custom_023`〜`custom_027` の5ファイルで衝突・欠番なし。
- **運用メモ(スキーマ変更の相互作用)**: M-8バッチの`custom_026`が当初テーブル再作成(DROP+RENAME)方式でCHECK制約を拡張しており、M-5/M-6バッチが検証した「安全なD1更新は破壊的スキーマ変更を拒否する」というガードに抵触することが判明。既存テーブル拡張ではなく新規加算テーブル方式に本人が書き直して解消(詳細はM-8参照)。
- **2026-08-19 完了: 10バッチすべて完了。** `bootstrap.sql`/`bootstrap-meta.json`を最終再生成し、モノレポ全体で最終検証を実施 ― `pnpm -r test`: line-sdk 3/3・sdk 55/55・liff 31/31・db 248/248・update-engine 215/215(`upgrade-matrix.test.ts`含む)・create-line-harness 61/61・web 52/52・worker 1541/1541(169ファイル)、全てグリーン。`pnpm -r typecheck`: 全パッケージエラーなし。P0/P1/P2/P3/P5は全項目完了。P4(法令遵守)とL-10(依存関係更新)は上記のとおり意図的に対象外。
- **2026-08-19: 13コミットに分けてコミット済み**(`docs:`/`fix:`/`feat:`/`chore:` の粒度で機能ごとに分割、コミット順は本ファイルの記録と対応)。未追跡の `.claude/`・`.omc/`・`out/` は本セッションの作業物ではないため意図的に含めていない。要人手対応が2件残っている: `.env.example` への `STAFF_API_KEY_HASH_SECRET` 追記(L-4、サンドボックスのsecret-readガードでブロック)、PR作成の判断。

### 新機能: 全体管理者(Platform Admin)ロール — 進行中
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

### 新規提案: Tenant Control Center + 期限付きサポートモード — 実装中(最小MVP一式を選択)

2026-08-19、ユーザーから大規模な追加提案を受領。現行の「常時全権閲覧」ではなく、通常モード(PHI非表示・稼働状況/整合性/セキュリティの監視)とサポートモード(理由・チケット番号・期限・MFA再認証を伴う一時的なPHIアクセス)の2層構成への再設計。ユーザーは選択式確認の結果「最小MVP一式(ダッシュボード+サポートモード+基本操作)」を選択。

**MVPの範囲(提案書「5. 推奨する最小MVP」に対応)**: 全体ダッシュボード / テナント一覧・概要 / LINE連携状態 / スタッフ・セッション / データ整合性 / 監査ログ(既存) / サポートモード内の患者閲覧。操作: サポートモード開始・終了 / テナント停止・再開(既存statusを流用) / LINE送信一時停止・再開 / テナント全セッション失効 / スタッフ無効化 / LINE接続テスト / 失敗Webhook・ジョブの単体再試行。

**注意(スコープ外として明示)**: 提案が求める「全体管理者専用の別オリジンへの分離」「Cloudflare Access + MFA」は、DNS・ホスティング・IdP設定などクラウドコンソールへの実アクセスが必要でこのセッションからは実行不可能。MFAの代替として、サポートモード開始時に**現在のパスワードの再入力(step-up)**を必須化した(`access-grant.ts`にコード内コメントで「真のMFAの代替ではない」旨を明記)。真のMFA・別オリジン化は運用チーム側で別途対応が必要。

**進捗**:
- [x] コア(自分で直接実装、検証済み・コミット済み): `custom_029_platform_admin_access_grants.sql`(グラントテーブル)、`platform-admin/access-grant.ts`(`createAccessGrant`=step-up付き発行、`requireActiveGrant`=強制、`endAccessGrant`、`listActiveGrants`、パスワード変更時のカスケード失効)。患者PHIの2ルート(`/tenants/:id/patients`、`/tenants/:id/patients/:patientId`)を有効なグラント必須に改修。グラントのライフサイクル3ルート追加(`POST /tenants/:id/support-grants`、`POST /support-grants/:id/end`、`GET /support-grants/active`)。`tsc --noEmit`エラーなし。
- [ ] 実行中(3バッチ並列委任、ファイル衝突回避のため`platform-admin/routes.ts`本体は1バッチのみが編集): (A)ダッシュボード集計・データ整合性検査(新規`dashboard-routes.ts`) / (B)スタッフ・セッション管理・LINE接続診断(新規`operations-routes.ts`) / (C)Webhook個別再試行・LINE送信一時停止(`custom_030`)・グラント retrofit に伴う既存`routes.test.ts`の修正(最優先タスクとして明示)。
- [ ] 未着手: `index.ts`への新ルーター群の最終配線(自分で実施予定)、フロントエンド(ダッシュボード・サポートモード開始/終了UI・常時カウントダウンバナー・テナント詳細のLINE/スタッフ/整合性タブ拡張)、統合テスト・コミット。

---

### P0 ― リリースブロッカー

- [x] **H-3** 完了(2026-08-19)。`custom_023_pharmacy_webhook_durable_inbox.sql` で既存の `pharmacy_webhook_event_receipts` に `payload`/`status`(pending/processing/completed/failed)/`lease_until`/`retry_count`/`dead_lettered_at` を追加(新規テーブルではなく既存テーブル拡張を選択 ― テナント/アカウントスコープのPKとON DELETE CASCADEを重複させないため)。ハンドラは200応答**前**にイベント本文と`status='pending'`を書き込み、durable書き込み自体が失敗した場合は200ではなく**500**を返すよう変更(以前は失敗しても200でイベントを握りつぶしていた)。`waitUntil`は共通の`runWebhookInboxEvent()`(lease→処理→completed/failed)を呼び、毎分Cronの`sweepWebhookInbox()`(10回失敗でdead-letter、それ未満はlease切れ/未完了を再処理)が同じ関数を再利用。実SQLite+実マイグレーション+実Honoルートでのテスト7件: durable書き込み失敗時の500応答とwaitUntil未実行/isolate停止を模したpending行のsweep復旧/同一webhookEventId二重配信で副作用1回/テナントA・B同一IDで互いに独立/retry→dead-letter/パージ境界。手動replay用のAPI/UIは未実装(dead-letter行のpayloadは保持されており`status='pending', retry_count=0`へ手動リセットすれば再処理可能、との設計メモを残す)。M-1/M-7も同一バッチで完了(下記)。

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
V-3(tags.ts)・V-4(webhooks.ts)自体のテナントスコープ化(スキーマ変更を伴う)は、上記invariantが効いている限り緊急度が下がるため今回のバッチには含めていない。**次回のスプリントでスキーマ変更込みの本格対応を計画すること(未実装・要別途タスク化のまま残す)。**

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
  - **新規フォローアップ(未実装、要別途起票)**: 実装エージェントが `apps/worker/src/routes/liff.ts:916` に同種の未スコープパターンをM-1より悪い形で発見(`matchedAccountId`がnullの場合、*全*テナントのアカウント紐付きシナリオがマッチしてしまう)。既存テスト(`liff-oauth-scenario-gate.test.ts`, `liff-friend-add-scenarios.test.ts`)が現在のnullアカウント時の挙動を固定しているため、仕様変更は製品判断が必要と判断し意図的に未着手。V-5と合わせて次回起票すること。

- [x] **M-3** 完了(2026-08-19、H-2と同一バッチ)。継続フォロー(`linkContinuitySubmission`/`completeContinuityAfterClose`/`pausePatientContinuity`)とマイナ(`markMynaLaunchRequested`/`recordMynaPatientReport`)の状態UPDATE+監査イベントINSERTを単一`db.batch`に統合。イベントINSERTは「UPDATE後の状態」を条件にした`INSERT ... SELECT ... WHERE`へ書き換え、UPDATEが不発(0件)でも孤立イベントが生まれない構造に変更。構造的テスト追加(UPDATE/INSERTがそれぞれ`operation: 'batch'`で発行されることをアサート)、成功。
- [x] **M-4 / L-3** 完了(2026-08-19)。`custom_025_pharmacy_tenant_integrity_v2.sql` を新規作成し、`pharmacy_prescription_submissions.source_handoff_id` が同一 `line_account_id` の `pharmacy_myna_handoffs` を参照することをINSERT/UPDATE双方でトリガー検証(custom_022と同スタイルの`RAISE(ABORT, ...)`)。L-3は調査の結果、`pharmacy_prescription_files`/`_events` の `submission_id` は既に `REFERENCES pharmacy_prescription_submissions(id) ON DELETE CASCADE` のネイティブFKで保護済みと判明(`foreign_keys=ON`で存在しないIDへのINSERTが実際に失敗することを実証)、追加のトリガーは不要と判断し migration ヘッダーコメントに記録。テスト5件追加、対象5ファイル16テスト成功。`bootstrap.sql`/`bootstrap-meta.json` 再生成済み(ただし他バッチのマイグレーション追加により最終統合時に再生成が必要 ― 下記「運用メモ」参照)。
- [x] **M-7** 完了(2026-08-19、H-3と同一バッチ)。`purgeWebhookEventReceipts()`を追加し、`status='completed'`または`dead_lettered_at IS NOT NULL`かつ30日超の行を削除、`pending`/`processing`はどれだけ古くても削除しない。6時間毎Cronで実行。テスト(29日/31日境界、`pending`は400日でも保持)成功。
- [x] **M-8** 完了(2026-08-19、修正版)。当初 `custom_026_pharmacy_prescription_view_events.sql` は `pharmacy_prescription_events.event_type` CHECKを`027_dedup_delivery.sql`の前例(テーブル再作成方式)に倣って拡張していたが、**M-5/M-6バッチの検証で`packages/update-engine`の安全なD1更新ガードが`DROP TABLE`/`RENAME`を無条件拒否することが判明**(`027_dedup_delivery.sql`はこのガード導入前の古いマイグレーションで前例として不適切だった)。既存テーブルのCHECK拡張ではなく新規の完全加算的テーブル `pharmacy_prescription_view_events`(id, submission_id, file_id, staff_id, viewed_at)を作る方式に本人が書き直して解消。`recordPrescriptionFileViewed()`とテストも追従。修正後 `upgrade-matrix.test.ts` 13/13・`bootstrap.test.ts`・`apps/worker` prescriptions配下94テストいずれも成功。「監査ログがないと全件通知になる」という表現は「不正閲覧時の影響範囲特定能力の欠如」に言い換え済み。
- [x] **M-9(バケット分離のみ)** 完了(2026-08-19、本人が直接実施)。`apps/worker/wrangler.toml` のデフォルト環境R2バケット名を `line-harness-images` → `line-harness-images-dev` に変更し本番と明示的に分離。**フィールドレベル暗号化は本タスクの対象外として意図的に見送り** ― `answers_json`等への暗号化適用は既存の`line-credential-store.ts`パターンを応用する設計だが、復号鍵管理・クエリ性能・既存データの移行方針を伴う独立した設計検討が必要なため、「実装」ではなく次回スプリントでの設計タスクとして別途起票すること。
- [x] **M-10 / L-1** 完了(2026-08-19)。M-10: `resolveAuthenticatedTenant`のバイパス分岐に `[auth] accept_via=LEGACY_ENV_OWNER_BYPASS tenant=<id>` ログを追加、`docs/ADMIN-AUTH.md`に廃止条件(監査期間ゼロ件確認後に廃止可)を明記(`LEGACY_API_KEY`側にも前例がなかったため本ドキュメントが両者のパターンを確立)。L-1: `auth.ts`(API_KEY/LEGACY_API_KEY)・`line-proxy.ts`・`packages/line-sdk/src/webhook.ts`の非定数時間比較をすべて置換。既存の`sameText`ヘルパーを`auth.ts`/`line-proxy.ts`で再利用、依存ゼロ方針の`line-sdk`パッケージには専用の`constantTimeEqual`をローカル実装(誤った「定数時間比較は不要」というコメントも削除)。`line-sdk`にvitestテスト基盤がなかったため新規セットアップ。テスト追加、`line-sdk` 3件・`apps/worker` 認証/line-proxy関連88件成功、`tsc`エラーなし。フルスイートで見えた失敗は他バッチ(webhook.ts, continuity/routes.ts)の作業中差分に起因すると確認済み。

---

### P4 ― 法令遵守(要事業・法務判断。コードだけで違反を断定しない)

外部レビューの指摘どおり、「違反を確認した」という表現は取り下げ、「コード/フォーム上では証跡を確認できない」という証跡不足の表現に統一する。

**2026-08-19: このセクションは今回の「PLANS.mdの未実装タスクを実装」の対象から意図的に除外した。** 理由: H-4/H-5/H-6はいずれも個人情報取扱事業者の所在・薬剤師法上の保存義務との整合・保存期間の3つの未解決の経営/法務判断(要判断事項1・2)に従属しており、その判断なしにコードだけで「実装」すると、間違った前提(例: 削除すべきでないデータを削除する、削除すべきデータを保持し続ける)で本番に影響するおそれがある。要判断事項2の文言修正(条番号訂正)のみ、法務判断を要しない単純な誤字修正なので直接反映した。H-4/H-5/H-6の実装は、要判断事項1・2の結論が出てから着手すること。

- [ ] **H-4** 問診同意欄への利用目的リンク追加は妥当な改善だが、「APPI違反」という断定は撤回する。まず**店頭掲示・契約書・外部プライバシーポリシー等、コード外での告知有無を確認**すること。`tenants` にURL列を足すこと自体は法令要件ではなく、表示主体(個人情報取扱事業者が薬局かプラットフォームか)・利用目的・委託関係・問い合わせ窓口・policy version/hashをどう持つかは要判断事項1の結論待ち。
- [ ] **H-5** 「画像の無期限保存=APPI22条違反」という断定を撤回する。APPI22条は数値の保存期間規定ではなく努力義務。**R2 lifecycle ruleがコード外(IaC/コンソール)で設定されている可能性を先に確認**する。処方箋/問診/着信画像/監査ログをprefixごとのretention classに分類した一覧(retention matrix)を作成してから削除方針を決める。
- [ ] **H-6** 「アーカイブのみ=APPI35条違反」という断定を撤回する。第35条は無条件の消去請求権ではなく要件付き。**「スタッフ一覧からアーカイブ除外」は法的な消去対応ではなく、法定保存中データを通常業務から隠すだけの副作用がある**ため、この1行修正は消去対応の代替にならないと明記した上で、開示・訂正・利用停止・消去請求の受付〜本人確認〜法定保存対象判定〜legal hold〜結果通知までの運用フローを設計する(要判断事項2の結論待ち)。
- [x] 要判断事項2の文言修正(条番号の誤りを訂正、法務判断不要のためこの行自体で完了): 「問診データ・処方箋画像は薬剤師法27条の調剤記録に該当するか」→「問診回答・画像・LINEメッセージのどの部分を、**薬剤師法27条(調剤済み処方箋の保存)・28条(調剤録の保存)**その他の業務記録として正式保存するか」

---

### P5 ― Low / Hardening

- (L-1 → 完了。M-10と同一バッチで対応済み、上記P3参照)
- [x] **L-2** 完了(2026-08-19)。`listNextIntakeExpectations(db, accountId, friendId?)` を `listPatientExpectations(db, lineAccountId, friendId)`(必須)と `listAccountExpectations(db, lineAccountId)` の2関数に分割、SQL断片は共有ヘルパーで重複排除。患者向け/スタッフ向け両ルートの呼び出し元を更新。テスト追加、成功。
- (L-3 → 完了。M-4と同一バッチで対応済み、上記P3参照)
- [x] **L-4** 完了(2026-08-19)。`custom_027_pharmacy_staff_api_key_hash.sql` で `staff_members.api_key_hash` を追加(平文`api_key`列は後方互換のため維持、破壊的変更なし)。新規シークレット `STAFF_API_KEY_HASH_SECRET` を採用(`LINE_CREDENTIAL_KEY_V1`は薬局スコープ・ローテーション前提のため不適切と判断、既存キーとの衝突チェックも実施)。`getStaffByApiKey()` はハッシュ照合→レガシー平文照合の順にフォールバックし、平文一致時に機会的にハッシュを自動バックフィル(D1書き込み失敗時も認証は失敗させない設計)。シークレット未設定でも従来どおり平文照合で動作し、無停止でロールアウト可能。テスト5件追加、`packages/db` 244件成功・`tsc`エラーなし、`apps/worker` 認証関連124件成功。**要対応**: `.env.example` への `STAFF_API_KEY_HASH_SECRET` 追記はサンドボックスの secret-read ガードでブロックされているため未実施 ― 人手で追記すること(`docs/CUSTOMER_DELIVERY.md` には追記済み)。
- [x] **L-5** 完了(2026-08-19)。`bootstrap-tenant-admin.ts`/`setup-tenant.ts`のHMACメッセージにテナント識別子(tenant id / tenant code)を追加(`pharmacy-tenant-admin-bootstrap:{tenantId}:{idempotencyKey}`等)。同一テナント+同一idempotency-keyでの冪等性は維持しつつ、異なるテナント間での初期パスワード衝突を解消。テスト追加(同一テナント→同一パスワード、異なるテナント→異なるパスワード)、成功。
- [x] **L-6** 完了(2026-08-19)。`rich-menus.ts`の`resolveLineClient`に`accountResourceOwnedByStaff`(既存ヘルパー再利用、再実装せず)による独立したテナント所有権チェックを追加。非所有アカウントは既存の「not found」相当のフォールバック(デフォルトのLINE_CHANNEL_ACCESS_TOKENクライアント)に扱いを統一。上流ガードをバイパスして直接呼び出す形のテストを追加し、単独でも越境を防ぐことを実証。
- [x] **L-7** 完了(2026-08-19)。`PrescriptionPage.tsx`の`startResubmission`から`setOriginalConsent(true)`/`setNoticeConsent(true)`を削除。`canSubmitPrescription`が両同意を要求する既存ロジックはそのままのため、再提出時に「再度チェックしてください」という一行のヒントUIを追加。テスト追加(jsdom未導入のためソースコード契約テスト方式)、成功。
- (L-8 → 完了。H-1と同一バッチで対応済み、上記P2参照)
- (L-9 → 完了。M-8と同一バッチで対応済み、上記P3参照)
- [ ] **L-10** 開発ツールチェーン依存の更新(vitest等、本番非搭載)。**2026-08-19: 今回は意図的に見送り。** 本番バンドルに含まれない開発ツールチェーンのみの脆弱性(Informational寄り)であるのに対し、`vite`/`miniflare`/`wrangler`のメジャーバージョン更新はビルド全体を壊すリスクが実質的な効果に見合わない。対応する場合は別タスクとして切り出し、`pnpm install` 後に全パッケージのテスト・ビルドが通ることを確認する専用の作業枠を用意すること。

---

### P6 ― レビュー手法・証跡整備(次回監査のため)

- [ ] **E-1** レビュー対象のhead SHA / base SHA / merge-base / dirty statusを固定して記録する運用にする
- [ ] **E-2** ルート網羅表(method + path + auth principal + tenant source + guard + repository関数)を作成する
- [ ] **E-3** DB網羅表(全tenant-owned tableのtenant列・FK・UNIQUE・NULL許否・R2参照)を作成する
- [ ] **E-4** バックグラウンド処理(webhook/Cron/Queue/retry/booking/broadcast/webinar/notification)の横断監査を別枠で実施する(V-1〜V-5を含む)
- [ ] **E-5** 否定テスト行列(Aの資格情報 × Bの全resource type)をテストスイートとして整備する
- [ ] **E-6** R2 lifecycle設定・prefix別retention・dev/prod分離状況を取得して記録する
- [ ] **E-7** サマリ文の言い換え。旧: 「テナント間・患者間の情報漏洩は確認されなかった」→ 新: 「テスト対象とした薬局LIFF4系統では、別テナント/別患者のPHIをread/writeできる経路を再現しなかった。ただしrepository全体のtenant isolationは未確立であり、generic CRUD・broadcast・background delivery等はP1(要調査)完了まで未確定として扱う」

## Done

- [x] 2026-08-19: マルチテナント化差分(`v0.26.0/feature/logical-multitenancy`)の初回セキュリティレビュー実施、Artifact/Markdownで報告(High 6 / Medium 10 / Low 10)
- [x] 2026-08-19: 外部レビュー(REQUEST_CHANGES)を受領。技術指摘を実コードで検証し本計画に反映。`GET /images/:key` 無認証PHI漏洩の指摘は実コード確認(`apps/worker/src/routes/images.ts:103-119`)により却下、その他の妥当な指摘(D1 batch()挙動・isolate非共有・薬剤師法条番号・APPI文言)は反映済み
