# Changelog

## Pharmacy v0.31.0 (Unreleased)

> Release gate未達のため、この項目はdraftです。package versionは`0.30.2`のまま維持し、seller tag、GitHub Release、deploy、account activation、LINE mutationは実施していません。

### ユーザーにとっての変更

v0.31.0は新機能を増やす版ではなく、現在の薬局LINE機能を安全に更新・復旧できる状態へ近づける版です。まだ未リリースのため、利用中の患者・薬局画面には反映されていません。

| 対象 | v0.31.0で変わること | 変わらないこと |
|---|---|---|
| 患者 | リリース前にLIFF画面を実ブラウザで確認し、起動失敗などの回帰を見つけやすくなります | 新しい画面・入力項目・操作手順は追加しません |
| 薬局スタッフ | リッチメニュー変更後の再確認・復旧に加え、LINEアカウント切替時は切替前の患者情報や読込結果を画面へ残さないようになります | 受付・チャット・患者対応の操作手順は変わりません |
| 運用担当者 | test、security scan、license確認、SBOM、build provenanceを1つのCIで確認でき、未達の版を公開しにくくなります | `dev`へのmerge、production deploy、実患者データや本番LINEアカウントの変更はまだ行いません |

### release evidenceとv0.30運用受入

- PHIを含まないcanonical release manifestへsource SHA、package version、独立したseller tag、environment、stage、D1 schema fingerprint、migration checksum、Worker・Worker assets・Admin・LIFFのartifact hash、deployment・rollback evidenceを記録
- production v0.30.2をread-onlyで再照合し、D1 migration 123/123とschema fingerprintを固定。seller tag commitとdeploy source SHAは別identityとして保持
- code deployment evidenceと業務受入を分離し、productionのdeployed byte equality、account activation、実端末受入は未証明のまま`UNVERIFIED`または`NOT_RUN`として維持
- Platform Admin CLIへaccount-scoped・PHI-freeなLINE rich-menu remote state GETだけを許可し、import・remote deleteなどのexternal mutationは引き続き拒否
- development synthetic LINE accountで同一v4-4 artifactのcreate・image upload・set-default・fresh read-back・explicit rollback・rollback後read-backを完遂。known-goodへ復帰し、結果不明・未解決operation・blind retry・remote deleteはいずれも0件

### CIとbranch protectionの簡素化

- CIを単一の`Repository Verify`へ統合し、全workspaceのtypecheck・test、migration contract、Worker・Web・LIFF buildを全pull requestで実行
- 重複していた`Worker CI`と`Web CI` workflowを削除し、path filterによってrequired checkが報告されない構成を解消
- `main`と`dev`のrequired status checkをGitHub Actionsの`verify` 1件、`strict=true`へ統一し、PR #77で成功を確認

### assurance baseline

- 同じ`Repository Verify`へLIFF Chromium smoke、CodeQL、new-commit secret scan、production dependency/license baseline、CycloneDX 1.6 SBOM、synthetic artifact生成を追加
- provenance用jobだけにOIDC権限を分離し、test/build jobへ付与せず、手動run `32567572017`でsynthetic artifactのattestation `42311202`を生成・検証
- new-commit secret scanとCodeQLはPASS、CodeQL open alertは0件。redacted full-history scanの181候補は値を保存せず確認し、文書内placeholder、test fixture、識別子、環境変数名のみでlive credentialは0件と判定
- production dependency auditはhigh/critical 0件、license inventoryはunknown/unlicensed 0件。LGPL packageのnative fileは配布artifactへ含まれず、LINE系51 packagesは公式のLIFF用途に限定しているため、現行artifactの是正は不要と判定
- `dev`へのmerge/deploy、production/LINE mutation、package version・seller tagの変更は行っていない

### releaseまでに残るgate

- 独立reviewerを設定し、`main`/`dev`の保護設定をfresh read-back
- main/production候補のsource SHA、deployed byte equality、runtime manifest digestをHuman Go後に実証
- 全gateがPASSするまで`pharmacy-v0.31.0`を作成せず、productionへ昇格しない

## Pharmacy v0.30.2 (2026-08-22)

### リッチメニュー画像とR2公開

- 6画面リッチメニューのsource画像を、LINEへ登録するtap領域と同じ3列×2行の境界で切り出すよう修正
- catalog versionを`v4-4`へ更新し、位置修正前のimmutable catalogを上書きせずrollback可能な状態を維持
- 228枚のJPEGを品質劣化が目立たない範囲で圧縮し、catalog全体をdeploy時の50MB upload budget内へ収める検査を追加
- catalog入力に変更がないpushでは画像生成とR2公開を両方skipし、通常deployによる不要なCPU・R2アクセスを停止
- 新しいimmutable catalogの公開時はR2 object一覧を1回取得し、途中再開で既に存在する画像だけをbyte比較
- 一覧にない画像だけをuploadし、全画像の確認後にmanifestを最後に公開する順序を維持
- 既存manifestが取得できないのに一覧上は存在する場合は公開を中断し、通信障害を未作成と誤認しないよう修正

### configuration doctorとLIFF疎通診断

- rich-menu readinessを固定されたcheck順に依存しない判定へ変更し、check追加・並び替えでREADY判定が壊れないよう修正
- configuration doctorから薬局LIFF endpointへ実際に接続し、HTMLを返す公開画面まで到達できるか検査
- DNS・接続・redirect・upstream応答・本文検査のどの段階で失敗したかを非機微なstageとして表示
- upstream HTTP statusを安全な数値だけで返し、response本文やcredentialを診断結果へ含めない境界を追加
- 手動redirectを追跡して各遷移先をallowlist検査し、外部hostへの意図しない接続を防止
- WorkerのTypeScript targetでも診断route testを実行できる互換修正を追加

### deployment metadataと管理画面

- runtime version注入のshell quotingを修正し、Worker・Web・LIFFのpackage versionが空文字になる問題を解消
- bundle versionと3つのpackage versionにsemantic version検査を追加し、空値・不正値をdeploy前に拒否
- リッチメニュー管理中にaccountを切り替えた際、旧accountの保存・公開・名称変更・削除処理のbusy表示が新accountへ残る不具合を修正
- runtime package versionを`0.30.2`へ統一し、LIFF表示とrelease contract testも同じversionへ更新
- database migration、保存済みリッチメニュー、LINE初期表示の自動変更は追加していない

## Pharmacy v0.30.1 (2026-08-21)

### リッチメニュー初期表示の修正

- 薬局リッチメニューの左上を「処方せん送信」とし、`pharmacy-prescription-send`へ遷移するv4メニューを初期表示に使用
- 新規accountの初期並び順も「処方せん送信」「受付状況」「服薬後フォロー」「薬局へ相談」「薬局情報」の順に固定
- 緊急避妊薬はリッチメニュー直下から外し、accountで有効な場合だけ「すべての機能」から利用できる既存導線を維持
- 修正画像を既存の`v4-2`へ上書きせず、immutable prefix `rich-menu-catalog/v4-3/`として分離
- Workerが参照するcatalog versionとmanifest keyを`v4-3`へ更新し、旧catalogをrollback用に保持
- catalog versionとmanifest keyを固定する回帰testを追加し、画像変更時にversion更新を忘れる事故を防止

### deploymentとversion整合性

- Cloudflare反映待ちで古いWorker versionを読む場合に備え、`/admin/version`の確認を5回から12回へ拡張
- 5秒間隔・最大約60秒の範囲で期待versionを待ち、最終的に一致しないdeployは従来どおり失敗扱いを維持
- Worker・Web・LIFF・SDK・MCP server・root packageのruntime versionを`0.30.1`へ統一
- LIFFの画面内version表示testを`0.30.1`へ更新し、package versionとの不一致を検出
- 既存のv3メニューと公開済みcatalogを変更・削除せず、rollback候補として保持
- database migration、顧客設定、LINE初期表示を自動変更する処理は追加していない

## Pharmacy v0.30.0 (2026-08-21)

### この更新で変わること

`v0.30.0`では、薬局ごとのリッチメニューを保存versionとして安全に作成・確認・公開・切替できる運用基盤、緊急避妊薬の中立的な予約リマインド、設定不足を一か所で確認できる診断画面を追加しました。患者・staff画面は説明書なしでも次の操作が分かる日本語表示へ整理し、認証・tenant境界・監査・ログの防御も強化しています。

### v4リッチメニュー運用

- accountごとの並び順とcapability revisionから、有効機能だけを含むCompact/Large画像候補を生成。228通りの事前生成JPEG catalogをhashで検証
- 保存versionをlayout、capability、LIFF ID、catalog、画像、tap action manifestのhashへ固定し、設定変更後の古いversionを公開前に拒否
- 画像とtap領域のpreview、公開中versionとの差分、version名変更、安全な未公開draft削除を管理画面へ追加
- LINE登録、初期表示切替、rollbackを別操作として維持し、dry-runで発行した短時間confirmation tokenを実行時に必須化
- LINE応答が不確定な操作を`running`/`unknown`として保存し、read-backによるreconcileと不足段階だけのresumeに対応。結果不明時の盲目的な再実行を防止
- `inactive`/`active`/`frozen`の運用状態とrevision CASを追加。状態変更だけではLINEの画像や初期表示を変更しない
- SHA-256 lowercase-hex処理を共通関数へ集約し、catalog、manifest、publish readiness、version作成の同一処理を一本化

### 緊急避妊薬の予約リマインド

- 予約1時間前の中立的なLINE通知を追加し、8:00〜21:00 JSTのquiet-hours境界と予約時刻を過ぎる通知の抑止を実装
- account単位の`inactive`/`active`/`frozen`制御、revision CAS、claim TTL、重複生成防止、失敗後の安全な再取得に対応
- 送信直前にtenant/account、capability、機能設定、受付状態、期限、予約時刻、友だち状態を再確認し、条件不一致を理由code付きで抑止
- 自動通知は既存のPHI-free承認済みtemplateとidempotency経路だけを使用し、資格情報取得失敗や結果不明時をfail-closedで記録

### 設定診断・日次運用・画面改善

- tenant mapping、account、staff assignment、capability、bot identity、LIFF、LINE credential、機能別readinessをまとめる非PHIのconfiguration doctorを追加
- 管理画面へ「本日の業務」集計、機能別の対応件数・状態、rich-menu readiness、設定不足から修正画面へ進む導線を追加
- Platform Adminへtenant作成、staff初期登録、credential設定状況、release/version情報をまとめた設定導線を追加
- 患者LIFFへ日本語の起動エラー、必須条件一覧、送信前確認、field単位errorとfocus移動、完了後の次の行動を追加
- staff sidebarを「本日の業務」「患者対応」「設定」「コンプライアンス」に整理し、「薬局 Growth Loop」の表示名を「薬局統計」へ変更。routeと内部識別子は維持
- session切れ後の安全なlogin復帰、44px以上の操作領域、二重送信防止、account切替中のstale response防止を主要画面へ反映

### セキュリティ・tenant境界・監査

- Platform Admin Bearer認証からstaff資格情報変更へ到達できた経路を閉鎖し、許可method/pathをserver側allowlistで限定
- login・password変更のrate limit、decoded path判定、pharmacy modeのredirect origin allowlist、LIFF route allowlistを強化
- form webhook URLをHTTPSかつpublic hostへ限定し、localhost・private IPと危険なheaderを拒否
- friends、tags、analytics等のqueryをtenant scopeへ修正し、limit/offsetをserver側で制限
- Myna endpoint暗号化をAAD付きAES-GCM v2へ更新し、既存v1暗号文のread互換を維持
- allowlist方式の構造化loggerと401/403共通deny logを追加。password、token、LINE user ID、問診回答、upstream response本文を記録しない検査をWorker全体へ拡張
- staff・credential・password変更と処方せん・問診閲覧をtenant監査eventへ記録

### データベース・開発環境・リポジトリ構成

- `custom_045_pharmacy_rich_menu_layouts.sql`: account別layoutと運用状態を追加
- `custom_046_pharmacy_rich_menu_operations.sql`: 保存version binding、公開・切替・rollback操作、confirmation証跡を追加
- `custom_047_pharmacy_emergency_reminders.sql`: 予約リマインド、claim、抑止理由、account別制御を追加
- `custom_048_tenant_admin_audit_events.sql`: tenant管理操作と機微情報閲覧の監査eventを追加
- Node.jsを22以上、TypeScriptを5.9系へ統一し、Dependabot、Cloudflare deploy workflow、`esbuild`安全版overrideを追加
- Workerの汎用routeを`admin`、`booking`、`crm`、`integrations`、`liff`、`marketing`、`messaging`へ再配置。公開HTTP pathは変更しない
- 薬局正本文書を`docs/pharmacy/`、fork元の汎用文書を`docs/upstream/`へ分離し、`docs/README.md`と各領域の`AGENTS.md`を追加
- agent runtime stateをsource treeから削除し、患者・staff向け一枚manual、README図解、画面例、MIT Licenseを追加
- package versionとseller tagは別identity。本版のseller tagは`pharmacy-v0.30.0`であり、push、GitHub Release、deploy、migration適用、LINE変更は別の明示操作として扱う

## Pharmacy v0.29.0 (2026-08-21)

### この更新で変わること

`v0.29.0`では、電子処方箋の患者・薬局導線、緊急避妊薬の最小情報キューと患者status、薬局ごとの患者向け機能ON/OFFを追加しました。機能をOFFにしても既存案件を孤立させず、新規受付だけを最終DB書込み境界で停止します。薬局管理画面・Platform Admin・read-only CLIは同じ非PHI readiness判定を利用します。

### 薬局ごとの機能ON/OFF

- 既存`pharmacy_account_capabilities`へ`electronic_prescription`、`emergency_contraception`、`pharmacy_info`を追加。電子処方箋と緊急避妊薬は新規accountでdefault OFF
- owner向け「機能設定」画面を追加し、処方せん、電子処方箋、患者アンケート、継続フォロー、服薬フォロー、緊急避妊薬、個別チャット、薬局情報をaccount単位で変更可能に
- 全機能OFF、44px操作領域、保存中の二重送信防止、未保存警告、account切替、CAS競合後の再取得に対応
- OFF確認に機能別の対応中件数を表示し、新規受付停止、既存データ非削除、完了・取消を継続するdrain挙動を明示
- clientから管理用capabilityや未知keyを変更できないallowlistと、owner-only更新、account scope、監査eventを維持
- capability更新は整数revisionのCASで競合を検出し、同時編集による後勝ち上書きを409で停止

### atomic admissionと既存案件drain

- 紙の処方せん、電子処方箋handoff、患者登録・問診回答、次回来局案内、服薬後フォロー、緊急避妊薬仮受付の最終INSERT/UPDATEへcurrent capability条件を追加
- route判定後に設定がOFFへ変わる競合でも、OFF後の新規recordを作成しないfail-closed契約へ変更
- OFF前の既存案件は本人・同一account staffによる履歴/status確認、取消、完了、期限切れ処理を継続
- periodic生成はOFFで停止し、既存recordのcleanup・expire・terminalizeを機能ON/OFFから分離
- 処方せん画面の紙・電子tabをURL routeへ統一し、画面内切替でも必ず同じfeature gateを再通過
- 処方せん有効期限リマインドは作成時と送信claim時の両方でcurrent capabilityを再確認し、OFF後の新規通知を停止
- 「薬局へ相談」は確認後・LINE送信直前に`manual_chat`を再取得し、OFFへ変わった場合は固定messageを送らない

### 電子処方箋

- 既存処方せんLIFFへ「電子処方箋を利用」タブを追加し、既存Myna handoffの作成、外部遷移、active handoff再開、患者申告、取消、紙への切替を接続
- 外部URLへ患者ID、LINE friend ID、LIFF IDを付与せず、serverが返したallowlist済みlaunch URLだけを使用
- 患者申告と薬局受領を別事実として表示し、薬局staffの確認前にshadow submissionや受付完了を作成しない
- 患者申告済みhandoffは外部画面の再起動と不正な再申告を表示せず、許可された紙fallbackだけを残す
- 薬局管理画面を「電子処方箋受付」として整理し、status filter、患者、申告時刻、期限、verification、既存処方せんdetailへのlinkを追加
- 同じ正式確認の再送は同一結果へ収束し、異なる正式確認は409で拒否。account切替中の遅いresponseも別account画面へ反映しない

### 緊急避妊薬

- 患者LIFFへserver time、状態、対応枠、受付期限、取消可否、次の行動をまとめたstatus cardを追加
- 薬局管理画面の受付キューと申告詳細を分離。一覧は受付番号、状態、枠、期限、制御用versionだけを返し、年齢帯、連絡方法、同意version、risk flag、性交日時、患者identity、暗号化payloadを返さない
- 申告詳細は同一accountの有効な研修修了薬剤師だけが取得でき、sensitive-read audit成功後に復号。audit失敗は503で停止
- 受付キューへstatus・対応枠・期限filterと50件単位のcursor paginationを追加
- 公開枠、readiness、DB受付境界で研修修了状態に加えて有効なstaff assignmentを必須化
- queue storage障害と不正cursorを区別し、障害を入力エラーとして誤表示しない
- staff-triggered LINE通知は、安全な既存atomic outbox/idempotency経路が不足するため本版では追加せず、status cardを必須範囲として維持

### LIFF全機能一覧とdirect route

- public LIFF configをactive accountの一意解決、固定allowlist順、`Cache-Control: no-store`、LINE API 0件へ変更
- 公開responseは`enabledFeatures`とcapability revisionだけを追加し、患者・friend・履歴・active件数を含めない
- 認証済みpatient/account ownership projectionを別APIに分離し、OFF前の既存履歴・案件がある機能だけdrain導線を維持
- disabled direct routeは中立的な利用不可説明と「すべての機能」へ戻る導線を表示。server mutationは409で拒否
- LIFF右上のversion表示を`v0.29.0`へ更新

### canonical readiness・Platform Admin・CLI

- 電子処方箋と緊急避妊薬の非PHI readinessを一つのaccount projectionへ集約
- 電子処方箋はcapability、Endpoint設定有無、確認status/source/checkedAtを返し、ローカルDB設定だけで外部Endpointを`READY`と推測しない
- LINE Login channel access tokenを持たない現行credentialではLIFF Server APIによるEndpoint自動確認を行わず、manual Console evidenceの日時をDB設定日時から推測しない
- 緊急避妊薬はcapability、公開設定の必須条件、研修修了薬剤師、期限切れholdを除いた利用可能在庫・将来枠をbooleanで判定し、患者情報や件数を返さない
- Platform Adminの`line-status`へLIFF ID、Login channel、Messaging/Login credential coverage、期待LIFF Endpoint、両機能のreadinessを追加
- `pnpm tenant:settings -- --preflight --account-id ...`を追加。read-onlyで同じprojectionを表示し、`BLOCKED`/`UNVERIFIED`はnonzero exitでactivationを停止
- optional capabilityがOFFの項目はpreflight全体を`BLOCKED`にせず、ONの項目だけをactivation条件として判定
- Platform Adminからrich-menu prepareへ入る経路をaccount/asset/LINE処理前の固定403で閉鎖

### データベースと互換性

- `custom_044_pharmacy_v029_capabilities.sql`を追加し、整数capability revision、緊急避妊薬detail access audit、既存薬局情報・緊急避妊薬公開状態の初回backfillを実装
- 初回移行後はcapabilityを唯一の権限元とし、旧`is_enabled`へはrollback互換の一方向mirrorだけを維持。旧列のINSERT/UPDATEからowner-only capabilityを再有効化できない
- migrationは再実行可能で、初回backfillを再実行せず、管理画面でOFFにした機能を戻さない
- bootstrap artifactとmigration metadataを`custom_044`まで再生成
- package versionとseller tag `pharmacy-v*`は別identity。seller tagは`pharmacy-v0.29.0`とし、GitHub Release、dev/main push、deploy、schema apply、account activation、LINE mutationは別の明示操作として扱う

## Pharmacy v0.28.0 (2026-08-21)

### この更新で変わること

`v0.28.0`では、患者がLINEから必要な機能へ迷わず進めるよう薬局LIFFとリッチメニューを再編し、来局判断に必要な薬局公開情報を薬局自身が管理できるようにしました。あわせて、患者問診の機微情報をフィールド単位で暗号化する保存・移行経路と、Platform Admin向けのtenant設定CLIを追加しています。

### 患者向けLIFFメニュー

- LIFF内に「すべての機能」画面を追加し、処方せん事前送信、受付状況、患者情報・アンケート、継続フォロー、服薬後フォロー、緊急避妊薬、薬局情報へ直接移動可能に
- 「すべての機能」画面の右上に、現在動作しているLIFFアプリのバージョンを表示
- 画面間の遷移と旧形式の`?page=`リンクでtenant固有の`liffId`を保持し、別のLINEアカウントへ誤って接続しないよう統一
- 「来局前確認」を、患者が目的を理解しやすい「緊急避妊薬」へ変更。画面内では仮受付であり、販売・服用・在庫を保証しない既存の薬剤師判断境界を維持
- 処方せん事前送信と役割が重複していた「お薬を受け取る」画面を現行メニューから廃止。公開済みリッチメニュー等の旧`/pharmacy/receive`リンクは、tenant固有の`liffId`を保ったまま処方せん事前送信へ転送
- 機能未設定時のHTTP 503を通信障害として表示せず、「この機能は現在利用できません。薬局にお問い合わせください。」という患者向け案内へ変更

### v3リッチメニュー

- 標準の初期リッチメニューを2500x1686の6エリア構成へ更新
- エリアを「緊急避妊薬」「受付状況」「服薬後フォロー」「薬局へ相談」「薬局情報」「すべての機能」で構成
- 新しい`initial-large-3x2-v3`プロファイルと画像を追加し、新規作成時の標準プロファイルとして使用
- 既存のcompact 3エリア版と単一処方せん受付版は互換用プロファイルとして保持
- ドラフト作成だけではLINEへの登録、初期表示設定、既存友だちへの一括適用を行わない従来のhuman gateを維持

### 患者向け薬局情報

- LINEアカウント単位の公開プロフィールを追加し、患者向けLIFFに薬局名、郵便番号、住所、電話番号、FAX番号、営業時間を表示
- 処方せん受付時間、時間外対応、休業・臨時案内、提供サービス、対応言語、支払方法、アクセス、駐車場、バリアフリー、公式サイトも任意項目として表示
- Google Maps URLが未設定の場合は住所から検索URLを生成。設定URLはHTTPSのGoogle Mapsホストに限定
- 公式サイトURLはHTTPSかつ認証情報を含まないURLだけを許可し、外部リンクには`noopener`/`noreferrer`を付与
- 電話番号は`tel:`リンクとして利用でき、FAX番号を含む連絡先はサーバー側でも文字種と最大長を検証
- 公開情報の最終更新日を表示。電話番号とFAX番号は常に項目を表示し、未登録時は「未設定」と明示。その他の任意項目は空欄のまま安全に省略

### 薬局情報管理画面

- 「患者向け薬局情報」編集画面を追加し、選択中のLINEアカウントに紐づく公開情報を編集可能に
- 更新権限をowner/adminへ限定し、一般staffからの更新を拒否
- `line_account_id`は認証済みstaffの割り当てとサーバー側middlewareから解決し、query parameterやrequest bodyの値を権限根拠として使用しない
- 薬局名、住所、営業時間を必須化し、テキスト長、電話/FAX文字種、Google Maps URL、公式サイトURLを保存前に検証
- アカウント切替中の遅いレスポンスが別アカウントのフォームを上書きしない読み込みガード、保存中の二重送信防止、未保存表示、成功・失敗フィードバックを追加

### 患者問診のフィールドレベル暗号化

- `pharmacy_patient_intake_responses`の`patient_snapshot_json`と`answers_json`を、AES-256-GCMの暗号化envelopeとして保存する経路を追加
- 暗号化コンテキストをtenant、LINEアカウント、LINE上の所有者、患者、回答、schema、revision、field、envelope/key versionへ結び付け、別scopeへの暗号文差し替えや再利用をfail-closedで拒否
- 1回答につき2つの必須field envelopeを保存し、片方だけ欠ける状態、nonce再利用、不正なfield名、scope不一致をDB制約と読み込み処理で拒否
- 暗号化envelopeと回答本体を同じD1 batchで保存し、部分成功を許可しない
- 移行期間はauthorization後のdual-readに対応。envelopeが揃う場合のみ復号し、移行開始後の不完全envelopeを平文へ暗黙fallbackしない
- Worker secret `PHARMACY_PHI_KEY_V1`が未設定の場合は書き込み前に503で停止し、平文の新規保存を継続しない

### 問診暗号化の移行・復旧

- account単位の`frozen`、`scrubbing`、`scrubbed`、`restoring`、`restored`状態を持つ移行管理テーブルを追加
- dry-runを既定とする上限付きbackfill、安定cursor、envelope byte検証、全件coverage digestを追加
- 平文scrubと復旧には承認者、承認参照、承認時刻を必須化し、対象accountの書き込みをfreezeして件数ドリフトを防止
- scrubは暗号化coverage確認後に既存JSON列を有効な空JSONへ置換し、restoreは保存済み暗号文から元のbyte列を復元
- `restored`後も自動で通常書き込みへ戻さず、旧Workerへのrollback継続または再scrubを人が判断する境界を維持

### Platform Admin tenant設定CLI

- `pnpm tenant:settings`を追加し、Platform Admin認証を使ってtenant/account設定をAPI経由で取得・変更可能に
- ownerだけが読めるローカル資格情報ファイルから接続情報を読み込み、tokenやsecret値を標準出力へ表示しない
- 患者・処方せん・問診等のPHIルートを対象外とし、許可された設定APIだけを専用session scopeで利用
- tenant IDに`:`を含む実環境の識別子へ対応し、Platform Admin identityをtenant/account境界検証まで保持
- 変更操作はdry-run、明示確認、監査記録を通し、LINEへのpublish、default変更、friend適用等の外部変更を暗黙実行しない
- リッチメニューの初期表示変更ではaccount scopeを必須化し、同じaccountを含むconfirmation token取得経路へ統一

### データベースマイグレーション

- `custom_039_pharmacy_public_profile.sql`: LINEアカウント・更新者staffへ外部キーで紐づく公開プロフィールを追加
- `custom_040_pharmacy_patient_intake_envelopes.sql`: 問診PHIの暗号化envelope、field allowlist、nonce一意制約、tenant/account/患者/回答scope外部キーを追加
- `custom_041_pharmacy_patient_intake_migration_state.sql`: account単位のwrite freeze、coverage、承認証跡、scrub/restore状態を追加
- `custom_042_pharmacy_public_profile_details.sql`: 処方せん受付時間、時間外対応、サービス、バリアフリー、言語、支払方法、公式サイトを追加
- `custom_043_pharmacy_public_profile_fax.sql`: 最大40文字のFAX番号を追加
- すべて既存データを削除しないadditive migration。dev/prodへの適用は各環境のdeploy workflowとmigration ledgerを通す

### 互換性と運用上の注意

- 旧`pharmacy-receive`リンクは削除せず処方せん事前送信へ転送するため、既に公開済みのリッチメニューからも到達可能
- 旧リッチメニュープロファイルは保持されるが、新規標準はv3。既存のLINEリッチメニューを自動置換しない
- 暗号化移行、平文scrub、restore、LINEリッチメニュー公開・初期表示変更はhuman gateの対象
- 本バージョン番号は共有薬局サービスの`pharmacy-v*`系列であり、OSS本体の`v*`系列とは別管理

## Pharmacy v0.27.2 (2026-08-20)

### この更新で変わること

`v0.27.2`は`v0.27.1`のリリースワークフローで顕在化したCIの不安定さを修正するパッチリリースです。

### CI安定化

- `packages/db`の`bootstrap.sql`整合性チェックが、node subprocess起動を伴うためvitestデフォルトの5000msタイムアウトを稀に超え、CIランナー負荷時にflakyになっていた問題を修正(タイムアウトを15000msに延長)
- timeout変更をbootstrap生成・同期検査のtestだけに限定し、repository全体のtest timeoutは緩和していない
- bootstrap.sqlの期待内容、checksum、migration整合性の判定条件は変更せず、待機可能時間だけを延長

### release scope

- runtime package versionを`0.27.2`へ統一し、CHANGELOGとversion contractを更新
- Worker、Web、LIFF、database schema、顧客データ、LINE設定に機能変更は追加していない

## Pharmacy v0.27.1 (2026-08-20)

### この更新で変わること

`v0.27.1`は`v0.27.0`のdev環境実機検証で見つかった不具合の修正と、CIの安定化を行うパッチリリースです。

### 重要なバグ修正

- マイナ在宅受付の受け渡し登録(`createMynaHandoff`)で、`pharmacy_myna_handoffs`への挿入が参照先の`pharmacy_prescription_expectations`挿入より先に実行されており、tenant整合性トリガーにより毎回`PHARMACY_MYNA_EXPECTATION_SCOPE_MISMATCH`で失敗していた不具合を修正。LIFF側で「お薬を受け取る」操作が常に失敗する状態だったものが復旧
- expectationを先に作成し、そのIDを参照するhandoffを同じbatch内の後続statementで作成する順序へ修正
- 複数statementのbind値と実行順を固定するrepository testを追加し、tenant/account境界を弱めずに再発を防止
- triggerや外部キーを緩和せず、既存のscope mismatch拒否をそのまま維持

### CI安定化

- Repository Verify workflowで共有パッケージのビルド漏れにより`packages/plugin-template`/`packages/mcp-server`のtypecheckが失敗していた問題を修正
- typecheck前に依存するworkspace packageをbuildし、生成型がないfresh checkoutでも同じ検証結果になるよう統一
- Repository Verify workflowのcheckoutがshallow cloneのため、タグ参照が必要なアップグレード互換性テストが失敗していた問題を修正(`fetch-depth: 0`を追加)
- release tagを使う互換性testをskipせず、CI側で必要なgit historyを取得する方針を維持

### ドキュメント

- `.env.example`に`STAFF_API_KEY_HASH_SECRET`・`PHARMACY_PHI_KEY_V1`(Worker secret)のプレースホルダーと設定方法の説明を追加
- secret値は例示せず、Cloudflare Worker secretとして設定する境界だけを明記

### release scope

- runtime package versionを`0.27.1`へ統一し、CHANGELOGとversion contractを更新
- database migrationと既存顧客データの変更は追加していない

## Pharmacy v0.27.0 (2026-08-20)

### この更新で変わること

`v0.27.0`では、個人情報保護法・薬剤師法に基づくプライバシー対応(利用目的通知・PHI保存期間・データ主体請求)、緊急避妊薬の来局前確認機能(Phase 1 MVP)、薬局管理画面・患者向けLIFFの安全性/正確性の一括改善、依存関係全体の最新化を行いました。

### プライバシー・個人情報保護対応

- テナント(各薬局)を個人情報取扱事業者と明示し、利用目的・問い合わせ窓口・委託関係を薬局ごとに設定できる機能を追加。問診同意にはその時点のポリシーバージョン・ハッシュを記録し、後からの改変と区別可能に
- PHI(処方せん画像・問診回答・マイナ連携データ・LINEメッセージ等)の法定保存期間を一律3年と定義したretention matrixを整備し、期限を超えた処方せん画像を安全に削除するジョブを追加(対象外のデータは次回課題として明記)
- 開示・訂正・利用停止・消去請求を受け付け、法定保存期間内は消去をDB制約レベルで拒否するデータ主体請求ワークフローを追加。legal hold判定は処方せん・問診・マイナ連携・服薬フォロー等9系統のPHIテーブルを横断して評価

### 緊急避妊薬の来局前確認(Phase 1 MVP)

- LINEを起点に、同意 → 最小限の確認 → 対応枠選択 → メーカー公式セルフチェック導線 → 仮受付番号、という来局前確認フローを追加
- 薬局番号・研修修了薬剤師・在庫・プライバシー環境など必須設定が揃うまで受付を非公開にするfail-closedゲートをDBトリガーで実装
- 性交後72時間の判定ロジックを独立した純粋関数として実装し境界値をテストで固定。販売可否の最終判断は店頭の薬剤師が紙のメーカーシートで行う設計とし、自動判定はしない
- 患者向け画面・通知から薬品名・性交・妊娠等の直接的な語を排除し、中立的な表現に統一

### 薬局管理画面・患者向けLIFFの安全性・正確性

- 処方せん受け渡し・LINEアカウント有効化・緊急停止・マイナ確認など不可逆操作に確認ダイアログと二重送信防止を追加
- JST/UTC混在表示、画像連打時のレース、服薬フォロー回答保存後の誤409応答、次回受診予告の停止不能など、データ不整合・誤表示・操作不能を多数修正
- シナリオ・タグ・Webhook設定へのテナントスコープ追加により、テナント間のデータ越境経路を解消

### 依存関係の全面更新

- 開発ツールチェーン(vitest, vite, wrangler等)および本番依存(Hono, Next.js 16, React, @cloudflare/workers-types v5, zod v4等)を最新安定版へ更新
- TypeScript 7への更新は、tsup・Next.jsのビルドツールチェーンとの非互換(内部Compiler APIへの依存)が実機で確認されたため見送り、5.9系を継続

### セキュリティ

- LIFFオリジンが `/api/liff/*` 以外の管理者向けルートにもcredentialed CORSアクセスできてしまう不備を修正
- リポジトリ全体の検証(typecheck・test・migration整合性)を一本化したCI workflowを追加

### その他

- Cloudflare Pages資産ハッシュのwrangler互換性を修正

## Pharmacy v0.26.0 (2026-08-19)

### この更新で変わること

`v0.26.0`では、`v0.25.0`で追加した薬局業務機能を、顧客ごとに分かれた実行環境から、1つの共有Worker・管理画面・薬局LIFFで安全に運用できる論理マルチテナント構成へ移行しました。
薬局ごとの患者・職員・LINE認証情報・シナリオ・通知・リッチメニューは引き続き分離し、運営者向けにはTenant Control Centerを追加しています。

### 共有マルチテナント基盤

- 薬局を表す論理tenantを導入し、各LINE公式アカウント、職員、患者、処方せん、継続フォロー、シナリオ、通知をtenant境界へ関連付け
- APIのquery parameterや画面上の選択値を権限根拠にせず、認証済みsession・職員割り当て・LINEアカウントの組み合わせをサーバー側で照合
- LINE友だちをtenant内の識別子として扱い、同じLINE user IDが別tenantに存在しても患者情報や会話履歴が交差しないよう分離
- account設定、staff、friends、chats、conversations、broadcasts、rich menus、scenariosなど既存経路のtenant scopeを統一
- 処方せんとhandoffの所属不一致をDB triggerでも拒否し、アプリケーションの検証漏れだけで他tenantへ接続できないよう強化
- 薬局tenantの作成、管理者bootstrap、LINE接続、初期設定を再実行可能なCLI/APIとして追加
- 顧客ごとのcheckout・更新PR・個別配信workflowを廃止し、共有サービスの一括更新へ移行

### Tenant Control Center / Platform Admin

- 通常の薬局職員とは分離した`platform-admin`認証と専用ログイン画面を追加
- tenant一覧、稼働状況、患者・職員・LINE接続・webhook・データ整合性の概要を横断確認できるダッシュボードを追加
- tenant詳細画面から職員管理、LINE接続診断、webhook失敗の確認・手動再試行、送信一時停止状態を操作可能
- 患者情報を確認するsupport modeは、理由・対象tenant・有効期限を持つ明示的なaccess grantがある場合だけ有効化
- support grantを管理者sessionへ結び付け、別sessionへの流用、期限切れ、対象tenant外アクセスを拒否
- support modeの開始・終了、患者情報の参照、設定変更、webhook再試行などを監査ログへ記録
- 初回Platform Admin作成後はbootstrap経路を閉じ、未初期化環境だけで有効になるguardを追加
- tenant単位で外向きメッセージを一時停止しながら、診断・復旧操作を続けられる運用経路を追加

### LINE認証情報と職員認証

- LINE channel secret、channel access tokenなどのtenant資格情報を専用storeへ移し、平文列の直接参照を廃止
- 既存LINE認証情報を新しいtenant storeへ移行するbackfillツールと、移行前後の整合性検査を追加
- 薬局職員API keyをkeyed hashで保存し、新規keyの平文永続化を停止
- 旧形式API keyは移行期間中のみ互換照合し、利用を監査できる経路を維持
- secret比較をconstant-time化し、token prefixだけでなくtoken全体をhashしたrate-limit keyへ変更
- rate limitをclient IPにも関連付け、異なる接続元が同じ短縮識別子へ集中する問題を抑制
- tenant管理者の初期password・職員割り当て・LINEアカウント割り当てを重複作成しないbootstrapへ統一

### Webhook・通知・データ整合性

- LINE webhookを処理前にdurable inboxへ保存し、永続化に成功してからackする方式へ変更
- webhook event receiptを保存し、再送された同一eventの重複処理を防止
- scenario照合をtenant単位へ限定し、別薬局の同名scenarioや友だち状態を選択しないよう修正
- 失敗eventをTenant Control Centerから確認し、監査付きで手動再試行できる復旧経路を追加
- マイナ受付確認と継続eventの書き込みをatomic化し、途中失敗で片方だけ保存される状態を防止
- 服薬フォロー、次回事前送信、使用期限、準備予定、活動通知のrepository・cron・routeにtenant境界を追加
- 薬局モードで許可されないbroadcast・marketing・汎用通知を、画面だけでなくroute・service・cronでもfail-closed
- 通知logへ患者氏名、LINE ID、処方内容などを出力しないprivacy contract testを追加

### 患者情報・処方せん画像の保護

- Platform Adminを含む処方せん画像参照を監査eventとして記録
- 画像取得時のtenant、処方せん、file revisionの対応関係を検証し、別tenantのobject key参照を拒否
- 管理画面の画像取得から不要な`Cache-Control`request headerを除去し、別origin構成でのCORS preflight失敗を修正
- browser cacheは`fetch`の`cache: no-store`で抑止し、WorkerのCORS allowlistを広げずに非保存動作を維持
- 古い処方せん画像revision、期限切れobject、orphan cleanupをtenant境界内で処理
- 患者・処方せん・継続情報の読み取りもtenant scopeを必須化し、support modeなしの横断参照を拒否

### 薬局LIFFとリッチメニュー

- LIFF内の処方せん受付、新規患者アンケート、マイナ受付、継続ページ間の移動でtenant固有`liffId`を保持
- tenantを解決できない起動、未設定のLINEアカウント、許可されていない遷移をエラー画面でfail-closed
- 共有LIFF buildから特定tenantの`VITE_LIFF_ID`依存を除去し、実行時のtenant情報で接続先を決定
- リッチメニューprofileが空または不完全な場合の公開を拒否
- 画像upload、公開、default切替、rollbackをtenant単位で検証し、失敗時に以前の公開状態を保持
- 管理画面のアカウント設定にtenant専用LIFF URLを表示し、共有Worker URLとの取り違えを防止

### Cloudflare配信とバージョン表示

- `dev`と`main`を環境単位で直列化する共有Cloudflare deployment workflowへ統合
- 開発環境のR2 bucketは`-dev`接尾辞を必須化し、本番画像bucketへの誤接続を拒否
- deployment前にD1・R2・Secrets・Worker名・Admin origin・LIFF originを検証し、既存bindingをsnapshotして配信後に照合
- additive migration検査をD1 response envelopeとtrigger bodyまで確認するfail-closed方式へ強化
- Worker、Admin、薬局LIFF、Worker Assetsをbuild後、リリース番号・build時刻・成果物hashを注入してWorkerを再build
- `/admin/version`が`0.26.0`を返すことをdeployment後に確認し、`0.0.0-dev`など古いmetadataの公開を検出
- Admin bundleと薬局LIFF assetに期待したorigin・共有tenant runtime marker・受付routeが含まれることを配信後に確認
- 配信作成、予約、イベント予約で使う`Idempotency-Key`をCORS許可headerへ追加

### 廃止・整理した機能

- 顧客ごとのsource checkout、更新manifest作成、更新policy、更新PR、個別Cloudflare配信workflowを廃止
- 管理画面の旧更新ページ、更新banner、更新progress modal、client update hookを削除
- tenant経路へ接続されない旧UI・重複service・未到達codeを削除し、確認済みの範囲で1,202行を削減
- `customer-release.json`による個別顧客release sequenceを廃止し、共有deploymentと`pharmacy-v*`タグへrelease authorityを統一
- SDK・MCPの薬局操作をtenant-scoped clientへ統一し、account指定なしの曖昧な操作を削減

### データベース変更

`v0.25.0`までの`custom_001`〜`custom_013`は編集せず、以下を追加しています。

- `custom_014`: 薬局論理tenant
- `custom_015`: tenant資格情報
- `custom_016`: tenant単位のLINE友だちidentity
- `custom_017`: LINEアカウントのtenant default
- `custom_018`: LINE channel資格情報store
- `custom_019`: tenant管理者bootstrap
- `custom_020`: 既存薬局職員のaccount backfill
- `custom_021`: webhook event receipt
- `custom_022`: tenant整合性constraint
- `custom_023`: durable webhook inbox
- `custom_024`: scenario tenant scope
- `custom_025`: tenant整合性constraint v2
- `custom_026`: 処方せん画像参照監査event
- `custom_027`: 薬局職員API key hash
- `custom_028`: Platform Admin、session、監査基盤
- `custom_029`: Platform Admin support access grant
- `custom_030`: tenant単位の外向き送信一時停止
- `custom_031`: support grantと管理者sessionのbinding
- `custom_032`: Platform Admin bootstrap guard

### v0.25.0から更新する際の重要事項

- これは個別顧客deploymentから共有マルチテナントdeploymentへの運用変更を含みます。従来の顧客更新workflowは使用しません。
- migrationは`custom_014`から`custom_032`までを番号順に適用し、既存migrationのchecksumとtrigger定義が一致することを確認してください。
- LINE資格情報backfill後、tenant・LINEアカウント・職員・友だちidentityの対応件数を確認してから旧平文参照を停止してください。
- `PLATFORM_ADMIN_KEY`、`CROSS_ACCOUNT_TOKEN_KEY`、`LINE_CREDENTIAL_KEY_V1`を共有Workerのsecretとして設定し、値をrepositoryやlogへ保存しないでください。
- 開発環境ではWorker、D1、R2、Admin Pages、LIFF Pagesがすべて開発用resourceを向いていることを確認してください。
- 本番反映前に、通常職員のtenant越境拒否、support grantの期限切れ、webhook再送、送信一時停止、LIFF tenant維持をsynthetic dataで確認してください。
- `pharmacy-v0.26.0`タグは、必須CIとmigration検査が成功したmerge済み`dev` commitにのみ付与してください。

## Pharmacy v0.25.0 (2026-08-18)

### この更新で変わること

`v0.25.0`では、LINEを「処方せんを送るだけの入口」から、受付・薬局確認・準備連絡・次回利用までを一つにつなぐ薬局運用基盤へ拡張しました。
患者さんはLINE上で必要な操作だけを行い、薬局スタッフは管理画面で受付状況と対応履歴を確認できます。

### 患者さん向けの変更

#### 処方せん事前送信

- リッチメニューの「処方せんを送る」から、患者さん本人または家族の送信先を選択可能
- 処方せん画像をLIFFから送信し、送信準備中・受付確認中・準備完了・差し戻しなどの状態をLINEで案内
- 画像の再撮影・再送信、受付キャンセル、原本持参の確認を追加
- 患者さんの送信操作だけで受付完了とはせず、薬局スタッフが内容を確認した後に正式受付へ進む設計を維持
- 薬局から準備予定時刻、受取方法、確認中の状況をワンクリックで通知可能

#### 新規患者アンケートと家族管理

- 本人・家族を分けて患者情報を登録し、同じLINEアカウントから家族分の受付を管理可能
- 氏名、氏名カナ、生年月日、性別、電話番号、郵便番号、住所などの基本情報を登録可能
- アレルギー、副作用経験、服用中の薬、既往歴・通院、お薬手帳、服薬状況、喫煙、飲酒、妊娠・授乳に関する項目を追加
- 回答は「あり／なし／わからない」などの選択式を基本とし、詳細入力が必要な場合だけ入力欄を表示
- 送信前に入力内容の確認画面を表示し、初回利用時の入力負担を抑制
- 処方せん送信画面から未回答の患者アンケートへ直接移動可能

#### 受付後の継続接点

- 調剤完了後も、次回の相談時期や次回事前送信をLINEから確認できる継続導線を追加
- 薬剤師が対象者と送信時期を決める服薬フォローを追加（全員への一律自動送信ではありません）
- 次回事前送信の案内は、患者さんが登録・休止・終了を選択できる状態で管理
- 自動通知には薬剤名、病名、用量、医療機関名、患者氏名などを含めず、受付・準備・一般的な確認に限定

### 薬局スタッフ向けの変更

#### 患者情報と対応履歴の確認

- 管理画面で患者の基本情報、最新アンケート回答、処方せん件数、準備予定、継続フォロー件数をまとめて表示
- 「対応履歴」を新しい順に表示し、アンケート回答、処方せん受付、状態更新、準備連絡、継続フォローなどの経過を確認可能
- 家族患者を個別に表示し、LINEアカウント単位の情報と患者単位の履歴を混同しないよう分離
- 患者・受付・LINEアカウントは薬局アカウント内でのみ参照でき、他薬局の情報は取得不可

#### 処方せん受付の状態管理

- 処方せん一覧を受付待ち・確認中・受付済み・準備中・準備完了・キャンセルなどの状態で絞り込み可能
- 状態変更と患者への定型メッセージ送信を同じ操作から実行可能
- 既に通知済み、通知失敗、古い状態への更新などを画面上で区別し、二重通知を抑制
- 発行元を「主な発行元／その他の発行元／不明」に分類し、薬局ごとの集計に利用可能
- 処方せん交付日と使用期限を薬局スタッフが確認・登録し、日付不明のものは自動通知対象にしない
- 電子処方箋は外部のマイナ在宅受付Webで本人認証・提出を行い、患者の自己申告と薬局の正式確認を分離

#### 準備予定と履行状況

- 受付可否、確認事項、準備予定時刻、受取方法を一つの編集画面で登録可能
- 準備予定時刻に対して、予定どおり・遅延・予定なしを集計
- 最新の有効な準備予定だけを評価し、古い予定の上書きや二重集計を防止
- 期限前日通知後に期限内完了した件数、期限確認が必要な件数を管理画面で確認可能

#### ブラウザ印刷と活動通知

- 管理画面の処方せん印刷ページから、受信画像を確認してブラウザの印刷ダイアログを開くことが可能
- 印刷対象は薬局アカウント・受付・画像リビジョン単位で確保し、同じ画像の二重処理を抑制
- ブラウザを閉じた場合は一定時間後に印刷タスクを回収し、古い画像リビジョンは再利用不可
- サーバーからの無人印刷、常駐エージェント、プリンター状態の自動取得は行わず、薬局PC上の明示操作で印刷
- 処方せん受付や確認の変化を、患者情報・LINE ID・処方内容を含めずに活動通知一覧へ表示
- 通知の確認済み／未確認をスタッフ間で共有可能

#### 薬局管理画面の整理

- 左メニュー最上部に「薬局機能」グループを独立表示
- 処方せん事前送信、患者アンケート、患者履歴、服薬フォロー、次回事前送信、印刷、活動通知、薬局ダッシュボードへ直接移動可能
- リッチメニューは既存の3分割を残したまま、全面1アクションの「処方せんを送る」テンプレートを追加
- 初期表示候補、画像保存、プレビュー、公開状態を既存のリッチメニュー管理手順から扱えるよう整理

### 薬局運用・ダッシュボード

- 初回友だち追加から初回処方せん送信までを計測し、初回送信率・2回目送信率を未成熟コホートと分けて表示
- 医療機関の発行元分類、`unknown`件数、発行元情報のカバー率を表示
- 準備予定時刻の遵守率、遅延件数、遅延時間の中央値・90パーセンタイル、予定なし件数を表示
- 使用期限確認済み、期限前日通知、通知後の期限内完了、期限確認が必要な件数を表示
- 受付・フォロー・継続など通知カテゴリ別の送信数、通知上限で停止した件数、unfollowとの時間的関連を表示
- unfollowは原因を断定せず、24時間／72時間以内の発生とサンプル数を「推定される時間的関連」として表示
- 能動通知は薬局アカウント単位で月1件を初期上限とし、医療・受付に必要な通知を停止しない

### 安全性・権限・プライバシー

- 薬局モードでは、処方せん受付、患者アンケート、履行確認、継続、薬局リッチメニュー、薬局ダッシュボードなどの許可機能だけを利用可能
- ブロードキャスト、汎用マーケティング、アフィリエイト、報酬、広告計測など薬局用途外の機能はAPI・cronを含めて拒否
- 画面を隠すだけでなく、サーバー側で薬局アカウントの機能許可を検証し、許可がない場合はfail-closed
- すべての薬局データをLINEアカウントIDで限定し、スタッフ認証済みだけでは他アカウントを操作できないよう強化
- 自動通知は承認済みメッセージIDと許可された変数だけで生成し、最終送信内容も検査
- マイナンバー、カード情報、暗証番号、資格情報、電子処方箋内容、処方せん画像本文を通知・分析ログへ複製しない
- 薬局スタッフ操作、状態変更、通知、印刷タスク、設定変更を監査可能な履歴として記録

### 更新時の保全と配信経路

- root、Worker、Admin、薬局LIFF、SDK、MCPの実行時バージョンを`0.25.0`へ統一
- `pharmacy-v0.25.0`を不変タグとして公開し、bundle、release-entry、release-manifestを同じリリースに添付
- 顧客更新PRとCloudflareデプロイ直前に、適用済みmigrationを壊さないadditive-only検査を実行
- 顧客ごとのD1、R2、Secrets、LINE設定、既存リッチメニュー、患者・受付データを保持したまま更新する保全ガードを追加
- 薬局LIFF PagesとWorker APIの接続先をデプロイ前に検証し、別アカウント・別環境への誤接続を拒否
- 開発環境ではWorker、薬局LIFF Pages、管理画面、D1、R2の設定を環境単位で分離
- 既存顧客の更新互換性下限は`0.21.3`のまま保持し、更新対象外になる変更は行わない

### データベース変更

薬局固有のmigrationは既存ファイルを編集せず、`custom_*`として追加しています。

- `custom_008_pharmacy_growth_loop.sql`: 発行元、初回・2回目送信、SLA、使用期限、通知計測、ダッシュボード
- `custom_009_pharmacy_print_queue.sql`: 印刷タスク、画像リビジョン、印刷状態、リース
- `custom_010_pharmacy_activity_notifications.sql`: 薬局活動通知と確認状態
- `custom_011_pharmacy_medication_followups.sql`: 薬剤師が管理する服薬フォロー
- `custom_012_pharmacy_next_intake_expectations.sql`: 次回事前送信の期待状態
- `custom_013_pharmacy_staff_accounts.sql`: 薬局スタッフとLINEアカウントの割り当て

### ご利用前の注意

- 印刷は薬局管理画面でスタッフが印刷操作を確定する方式です。サーバーからプリンターへ自動出力はしません。
- 電子処方箋の「手続きを終えた」は患者さんの自己申告であり、薬局の正式受付確認とは別です。
- 準備予定時刻は薬局が登録した予定であり、在庫や調剤を自動確約するものではありません。
- 本番利用前に、薬剤師による通知文面、使用期限の確認手順、印刷端末、スタッフ権限、個人情報保護方針を確認してください。

## Pharmacy v0.23.1 (2026-08-17)

### dev/main同期と本番LIFF配信の整合

- `dev`を`main`の最新履歴へ同期し、顧客更新の基準コミットをv0.23.0公開タグへ固定
- 本番LIFFを専用Pages配信へ切り替え、LINE DevelopersのLIFFエンドポイントを同一オリジンへ整合
- 本番LIFFオリジンをWorkerのCORS許可設定へ反映し、処方せん受付・新規患者アンケートのAPI接続を確認
- 本番アカウントのLIFF IDとD1のアカウント設定を照合し、既存のテナント設定を保持したままデプロイできることを確認
- Worker、管理画面、LIFFのデプロイ後ヘルスチェックと、LIFF遷移URLのクエリ引き継ぎを確認
- GitHub Actionsの顧客リリースタグ生成に固定のbot署名者を設定し、Runner環境差異で公開処理が停止しないように修正

### 顧客更新メタデータ

- 顧客更新のリリースシーケンスを2へ進め、v0.23.0の公開ソースコミットからの連続更新として記録
- 顧客側のD1・R2・Secrets・LINE設定を更新処理から保護する既存の設定保持経路を継続
- 今回は新規migrationを追加せず、顧客側のDB変更なしで更新できるリリースとして整理
- 本番反映前の顧客確認を残すため、更新クラスは`manual`として公開

## Pharmacy v0.23.0 (2026-08-17)

### LINEからの処方せん受付

- リッチメニューの「お薬を受け取る」から、電子処方箋・紙の処方箋・医療機関から送信済みの受付方法を選択できる受付ゲートウェイを追加
- 紙の処方箋はLIFFからテナント管理下のストレージへ直接アップロードし、1件あたり1〜4枚の画像を順序付きで登録
- 原本提出、調剤確約ではないこと、薬局確認が必要であることを受付画面で明示
- 送信の二重実行を防ぐ冪等処理、受付履歴、未確認・確認中・受付済みなどの状態表示、再提出依頼後の画像差し替えを追加
- 受付画像の期限処理、キャンセル、再提出、管理者による確認・差し戻し・完了処理を追加
- 処方内容や薬品名をLINE通知へ複製せず、受付状況・確認状況・準備予定だけを通知

### 新規患者アンケート・家族患者管理

- LINEから本人または家族を選んで初回患者プロフィールを登録・更新
- 続柄、氏名、氏名カナ、生年月日、性別、電話番号、郵便番号、都道府県、市区町村、住所、建物名を入力可能
- 選択式を中心に、アレルギー、副作用・気になる症状、服用中の薬、既往歴、服薬状況、喫煙、飲酒を回答可能
- 「なし」「あり」「わからない」などの選択肢と、必要な場合だけ詳細入力を表示する条件付き入力を採用
- 送信前に安全確認の要約を表示し、入力負担を抑えながら薬局側で確認しやすい形式に統一
- 家族単位の患者一覧、患者ごとの受付・処方せん履歴への導線を追加

### 電子処方箋・マイナ在宅受付Web連携

- 電子処方箋を選択した場合、LINE内に認証画面を埋め込まず、薬局固有のマイナ在宅受付Webを外部ブラウザで開く導線を追加
- 遷移前に本人認証、情報提供同意、電子処方箋提出の手続きを案内し、遷移後はLINEで患者の自己申告を受け付け
- 患者の「手続きを終えた」と薬局の正式な電子処方箋確認を分離し、自己申告だけで受付済みにはしない状態モデルを追加
- 薬局職員による到着確認、処方箋なし、他薬局提出済み、期限切れ、患者不一致、紙処方箋切替の確認結果を構造化
- マイナンバー、カード情報、暗証番号、資格情報、電子処方箋の内容をHarnessへ保存しない境界を追加
- マイナ受付が使えない場合の紙・FAX・電話へのフォールバック導線を追加

### FulfillmentQuoteと継続フォロー

- 薬局が正式受付を確認した処方せんに対し、FulfillmentQuoteで履行可否、条件、準備予定時刻、受取方法を登録可能
- 受取、配送、居宅訪問、施設配送の候補と、条件付き・確認中・対応不可などの状態を管理画面から更新
- 履行可否を確定する前は患者へ確約通知を送らず、確認中であることと回答予定時刻を正直に通知
- 調剤完了後に次回処方を待つ継続状態を作成し、服薬フォロー、次回受付、休止、完了、リマインドを管理
- 患者向け通知に薬品名、疾患名、用量、医療機関名を原則含めないプライバシー配慮を追加

### リッチメニュー管理

- リッチメニューの一覧から薬局向けテンプレートを選択し、初期表示テンプレートを指定可能
- 生成済み画像をR2へ保存し、画像の再利用・表示確認・公開状態を管理
- 初期リッチメニューの自動作成、ユーザーへ表示するかどうかの切替、タグ単位の適用を追加
- 画面切替用のアクションと薬局向け受付ページへの導線を追加
- Codex／Claude Codeなどの運用ツールから、薬局用リッチメニューの作成・更新・公開を行える管理APIを追加

### 薬局管理画面・運用基盤

- 処方せん受付キュー、受付詳細、画像確認、患者アンケート、マイナ受付確認、FulfillmentQuote、継続フォローの管理画面を追加
- テナントIDを受付・患者・リッチメニュー・監査イベントの必須境界とし、他薬局のデータを参照できないように強化
- 職員操作の権限確認、状態変更の競合検知、監査イベント、期限切れデータの安全な削除を追加
- `custom/pharmacy/` 配下を中心に薬局固有コードを分離し、公式LINE Harnessの更新と個別設定を分離
- 顧客ごとのD1、R2、Secrets、LINE設定を保持したまま更新するCloudflareデプロイ・顧客リリース経路を追加
- 開発環境のLIFFオリジンを明示設定し、処方せん送信・患者アンケートで発生していた `Load failed` を修正
- 薬局用 `custom_*` migrationをリリースメタデータへ含め、顧客更新時のDB整合性検証を追加

## v0.21.3 (2026-08-15)

### Worker Assetsアップロードの修正（2026-08-16）

- Cloudflare Workers Assets APIへ送るmanifestキーを必須の`/`始まりへ修正
- migration完了後、Assets upload session作成時にHTTP 400（code 10304）で停止する問題を解消
- 修正版CLI `create-line-harness@0.2.8` / update engine `0.0.10`を公開
- Cloudflare Pagesのasset keyをWrangler互換BLAKE3へ修正し、deploy成功後に全パスHTTP 500となる問題を解消
- Adminのみを安全に再同期する修正版CLI `create-line-harness@0.2.9` / update engine `0.0.11`を公開

### 安全なアップデート経路

- Worker本体と `apps/worker/dist/client` のWorker Assetsを同じリリースbundleに同梱し、一体で更新
- v0.14.1〜v0.21.2のDBを、037以降の累積マイグレーションで直接最新版へ収束
- マイグレーションをSQL文単位で適用し、途中適用されたファイルも未適用文だけ継続
- 適用済みファイルのチェックサム台帳を追加し、再実行時のDML重複を防止
- 破壊的DDLを更新開始前に拒否
- Worker Versionを保存し、失敗時にコード・bindings・Assetsをまとめてロールバック
- CLIの途中失敗後は、同じupdateコマンドの再実行でWorker・Admin・LIFFを再同期
- 旧形式の `?page=webinar&slug=...` をLIFF Pagesのウェビナー画面へ転送

### 更新方法

Worker Assets対応前のバージョンでは、管理画面内の更新ボタンではなく次を実行してください。

```bash
npx create-line-harness@latest update
```

## v0.21.0 (2026-08-14)

### ライブCTAから個別相談を即時確定

- オートウェビナーのフォーム送信後、その画面のまま空き枠を選び、個別相談を即時確定
- LINE Harnessの受付時間、日付別枠、既存予約、Google Calendarの予定、60分のリードタイムを反映し、確定直前にも二重予約を検査
- Google Meet付き予定、`meet_consultations`、前日・1時間前のLINEリマインド、確定通知を一括作成
- 管理画面からGoogleアカウント本人が許可するOAuth接続を追加。サービスアカウントキーとカレンダー共有は不要
- OAuth権限は `calendar.events` と `calendar.events.freebusy` の2つだけに限定
- 設定とエラー解決を `docs/upstream/wiki/28-Google-Calendar-and-Webinar-Booking.md` に追加

### その他

- シナリオ・自動応答の友だち別送信でも `{{liff_id}}` を配信アカウントへ追従
- 「マイル」キーワードで、ユーザー本人のマイルページをreply messageで返信
- メディア問い合わせをD1へ保存し、通知成否を記録
- 即時ステップ配信がcronと同じ条件判定を行うよう修正
- チャット一覧のプレビュー・並び順・ページングを、プロキシ送信を含む実際の最新メッセージへ統一

### Database

- migration 067: 「マイル」キーワード自動返信
- migration 068: メディア問い合わせ保存

過去の変更は [GitHub Releases](https://github.com/Shudesu/line-harness-oss/releases) を参照してください。
