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
- [x] **L-4** 完了(2026-08-19)。`custom_027_pharmacy_staff_api_key_hash.sql` で `staff_members.api_key_hash` を追加(平文`api_key`列は後方互換のため維持、破壊的変更なし)。新規シークレット `STAFF_API_KEY_HASH_SECRET` を採用(`LINE_CREDENTIAL_KEY_V1`は薬局スコープ・ローテーション前提のため不適切と判断、既存キーとの衝突チェックも実施)。`getStaffByApiKey()` はハッシュ照合→レガシー平文照合の順にフォールバックし、平文一致時に機会的にハッシュを自動バックフィル(D1書き込み失敗時も認証は失敗させない設計)。シークレット未設定でも従来どおり平文照合で動作し、無停止でロールアウト可能。テスト5件追加、`packages/db` 244件成功・`tsc`エラーなし、`apps/worker` 認証関連124件成功。**要対応**: `.env.example` への `STAFF_API_KEY_HASH_SECRET` 追記はサンドボックスの secret-read ガードでブロックされているため未実施 ― 人手で追記すること(`docs/CUSTOMER_DELIVERY.md` には追記済み)。
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

**却下・保留のまま(実装しない)**:
- Myna `tenant_alias` のグローバルユニーク衝突(low, `endpoint-repository.ts:148`)と `/r/myna/:tenantAlias` 未認証URL開示(low, `myna/routes.ts:184`)は今回のisolation調査で唯一生き残った2件。優先度lowのため今バッチには含めず次回起票。
- H-4/H-5/H-6(法令遵守)は要判断事項1・2待ちで引き続きブロック。今回のスキャンでも実装対象外と再確認済み。
- E-6(R2 lifecycle取得)・E-7(サマリ文言い換え)はリポジトリ外作業のため対象外。

## Done

- [x] 2026-08-19: マルチテナント化差分(`v0.26.0/feature/logical-multitenancy`)の初回セキュリティレビュー実施、Artifact/Markdownで報告(High 6 / Medium 10 / Low 10)
- [x] 2026-08-19: 外部レビュー(REQUEST_CHANGES)を受領。技術指摘を実コードで検証し本計画に反映。`GET /images/:key` 無認証PHI漏洩の指摘は実コード確認(`apps/worker/src/routes/images.ts:103-119`)により却下、その他の妥当な指摘(D1 batch()挙動・isolate非共有・薬剤師法条番号・APPI文言)は反映済み
