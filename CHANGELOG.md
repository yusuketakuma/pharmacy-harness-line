# Changelog

## Pharmacy v0.36.3 (2026-09-19)

> パッケージ／ソースのバージョンを`0.36.3`として確定し、v0.36.2 フォローアップ監査の修復一式を`dev`で管理します。ソースコードのタグ`v0.36.3`と販売者向けリリース`pharmacy-v0.36.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

v0.36.2 に対するフォローアップ監査(2026-09-18〜19)で確認した欠陥を閉じる patch です。新 API・migration・通知経路の追加はなく、変更は `custom/pharmacy` seam の LIFF 側とテストのみです。計画は PLANS.md の v0.36.2 節(フォローアップ監査)に記録済みです。

### v0.36.2 との差分概要

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| 旧 LINE WebView 互換 | `compat.ts` を追加し、`crypto.randomUUID` / `structuredClone` 非対応環境向けフォールバック(`pharmacyUuid` / `cloneJsonValue`)を薬局シーム全箇所に適用 | 実装済み |
| 入力中フォームの保護 | quiet(バックグラウンド)リフレッシュがマウント済み内容を破壊しない契約を全ページに統一。reconnect/auto-retry の callback を named idempotent read に限定し、last-started-wins の load epoch で古い応答が新しい変更結果を上書きしないことを保証 | 実装済み |
| 下書きのテナント隔離 | intake/new-patient 下書きキーを `liffId` でスコープ化し、共有 Pages オリジン上のテナント跨り PHI 露出を解消。legacy キーは write→re-read 検証→削除の restore-once マイグレーション。`sweepIntakeDrafts` は自テナント prefix のみ | 実装済み |
| 保存ロック・整合 | profile-save ミューテックスを `finally` で無条件解放し supersede 時のロック残留を解消。`reconcileAfterSendError` の history 直書きに epoch bump を要求。`PatientProfileForm` を `pendingProfileSave \|\| busy` で全凍結 | 実装済み |
| 回帰ガード | request-gate の stale レスポンス隔離(Myna/ECAdmin/Today/DSR × unmount後・フィルタ変更後 × 200/503)を e2e でピン留め。LIFF 側は profile 凍結・mutex 解放・history epoch のソースピンを追加 | 実装済み |

### 差分で確認した安全性

- **後方互換**: 公開 API・CLI・ルート・ペイロード・マニフェスト契約は不変。localStorage キーの移行は write→検証→削除の restore-once で非破壊。lockstep deploy 不要。
- **検証**: `pnpm --filter liff test` 202件、`tsc --noEmit`、`pnpm --filter liff build`、`playwright` e2e 21件、`v035-readiness`/`version-contract` テスト全てパス。
- **残 Human Gate**: 実機 LINE 動作確認・VoiceOver・本番反映は未実施。

## Pharmacy v0.36.2 (2026-09-18)

> パッケージ／ソースのバージョンを`0.36.2`として確定し、患者向けLIFFの状態遷移の信頼性仕上げ一式を`dev`で管理します。ソースコードのタグ`v0.36.2`と販売者向けリリース`pharmacy-v0.36.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

v0.36.1で増えた状態遷移（自動再試行・下書き・ステータス通知）を、患者が信用できる状態まで閉じるpatchです。新API・migration・通知経路の追加はなく、変更は`custom/pharmacy` seamのLIFF側のみです。計画はPLANS.mdのv0.36.2節（V036-12〜17）に固定済みで、条件付き2件（画像ごとの状態表示・接続状態案内）は採用条件を満たしたため実装しています。

### v0.36.1との差分概要

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| 自動再試行の堅牢化 | `usePharmacyAutoRetry`をload単位へ粒度変更（PrescriptionPage 4系統・PatientIntakePage 2系統が独立にretry）。attempt消費を`setTimeout`発火時へ移し、StrictModeのdev double-mountでretry budgetを二重消費しない。`mounted` guardでunmount後のsetStateを抑止 | 実装済み |
| 下書きの信頼性 | `{savedAt, data}` envelope＋24時間TTL＋期限切れ削除。envelope無しのlegacy draftは一度だけ復帰（「保存時刻は不明」表示）し、次回保存で自動migrate。復帰時のみ「下書きを復元しました」通知＋保存時刻表示。切替・離脱ダイアログを「この端末には下書きが残ります」へ実挙動に整合 | 実装済み |
| 読み上げの単一経路化 | live region（`role="status"`/`alert`）とfocusを分離：成功・情報ブロックはlive regionで読み上げ（scrollのみ、focus/tabIndex廃止）、エラーブロックはfocusで読み上げ（live role廃止）。二重読み上げを解消 | 実装済み |
| `aria-busy`の限定 | 服薬フォローの選択肢で`aria-busy`を実際に送信中のボタンのみへ限定（他の選択肢はdisabledのままbusy非表示） | 実装済み |
| 平易化 | `既往歴・通院中の病気`→`これまでにかかった病気・現在通院中の病気`、`説明と明示同意`→`説明と同意`（明示性は必須checkboxが担保）、`仮受付`へ初出説明`（確定前のお申し込み）`を付記 | 実装済み |
| 画像ごとの送信状態 | 処方せんの各画像に`送信待ち/送信中…/送信済み/要再試行`の状態chip。`prescriptionApi.upload`逐次呼出を包む状態遷移のみで、upload transportは不変。失敗画像以降は一律`要再試行`で、結果不明を成功表示しない | 実装済み |
| 接続状態案内 | `usePharmacyOnline`（offline/onlineイベント監視、online遷移時のみnamed read callback発火）＋Shell共通`PharmacyOfflineBanner`。全ページのidempotent readを復帰時に局所再取得。ページreload・dirty form/画像/mutationの自動送信なし | 実装済み |
| 回帰ガード | `v036-ui-rules.test.ts`に追加：attemptのtimer内消費、retry/reconnect callbackのnamed read必須、focus target×live region併用禁止、`aria-busy`スコープ、平易化文言、画像4状態、`location.reload`禁止 | 実装済み |

### 差分で確認した安全性

- **下書きの期限と後方互換**: TTL 24hは工学的提案値（法令由来でない）。envelope無しlegacy draftは一度復帰して次回編集で新形式へ自動移行し、データを失わない。`data:null`/corrupt envelopeは復帰せず握りつぶす。患者A/Bのキー分離は`intakeDraftKey(patientId)`で維持。
- **読み上げの重複排除**: `role="status"`（暗黙polite+atomic）ノードへのfocus移動はスクリーンリーダーで二重読み上げになるため、読み上げ経路を1本に統一。focusを受けるエラーブロックからは`role="alert"`を除去。
- **接続復帰時の自動再取得**: `usePharmacyOnline`のcallbackはnamed idempotent readのみ（ガードで強制）。provider層へ`usePharmacyOnline(retry)`を配線すると`access.loading`が全childrenをskeletonへ差し替えdirty formを破壊するため、復帰再取得はpage層のreadのみに限定。
- **画像状態の正直表示**: `done`は`upload()`のresolve後のみ。files配列が変わるとindex対応が崩れるため全量`queued`へreset（stale状態を引き継がない）。結果不明を`送信済み`表示しない。
- **API契約**: 変更なし。upload transport・draft・intake answersの送出形式は不変。UI層のみの変更のため、旧LIFFとのlockstep deployは不要。

### レビューで検出・修正した事項

- provider層へ`usePharmacyOnline(retry)`を配線すると、復帰時のaccess再読込が`loading:true`で全childrenをskeletonへ差し替え、入力中フォームを破壊する問題を検出し取り止め（復帰再取得はpage層readへ限定）。
- `loadDraft`のenvelope判定で`data:null`やnull本体のdraftが`data.answers`参照でTypeErrorになる経路を検出し、null/undefinedの早期returnで防御。
- ガードテストが`feedback.tsx`内のhook定義行とコメント中の`role="alert"`記述を誤検出したため、定義site除外・コメント行skipで修正。
- `isEnvelope`の`Boolean(value)`ナローイングがTS18047を出したため`value !== null`へ修正。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件を`0.36.2`へ統一 |
| liff | 28 files / 189 tests PASS、`tsc --noEmit` PASS、Vite build成功 |
| 破壊的変更 | なし。API field/routeのrename・削除、schema変更、旧契約の意味変更なし |
| 実LINE受入 / production deploy | NOT_RUN — Human Gate。local greenでは代替しない |
| LINE送信取消 | BLOCKED継続 — V036-6-U1として正本確定まで実装しない |

## Pharmacy v0.36.1 (2026-09-18)

> パッケージ／ソースのバージョンを`0.36.1`として確定し、患者向けLIFFのインタラクション・フォームUX改善一式を`dev`で管理します。ソースコードのタグ`v0.36.1`と販売者向けリリース`pharmacy-v0.36.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

患者側LIFFに対して、高齢患者を前提とした「迷わない・消えない・待ちが分かる」インタラクション層を追加しました。画面遷移・ステップ移動・読み込み・送信・失復帰の5面を、`custom/pharmacy` seam と `index.css` の共通部品で統一しています。API契約・DBスキーマ・通知経路の変更はありません。LIFF側のみの変更です。

調査はサブエージェント4系統（LIFF公式ドキュメント / WCAG 2.2・DADS / 高齢者UX / GOV.UKフォーム設計）で実施し、採用した提案だけを実装しています。本文18px一括化・全画面の情報密度削減は、情報量確保のユーザー方針と競合するため採用していません。

### v0.36.0との差分概要

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| 画面遷移 | `PharmacyShell` で pathname 変化時に `pharmacy-page-enter` フェード（0.18s）＋ `scrollTo(0,0)`。query変化はscrollのみに分離し、タブ切替でフォーム入力を失わない。遷移ごとに `document.title` を「画面名｜薬局名」へ更新 | 実装済み |
| ステップ遷移 | 問診3ステップ・EC（入力→確認）に方向スライド（次へ=左／戻る=右、0.2s）＋遷移後の見出しへ自動 focus。`role="progressbar"` 付き進捗バー | 実装済み |
| ローディング | 全ローディング表示を `PharmacyLoading`（構造模倣スケルトン＋`role="status"`＋`sr-only`ラベル）へ統一。対象：shell/gate/menu/timeline/followup/continuity/info/処方せん×3/問診/EC | 実装済み |
| 送信フィードバック | 全送信ボタンに `PharmacySpinner`（送信中…）＋ `aria-busy`。完了ブロックは `PharmacyStatusBlock`（mount時focus＋scrollIntoView）へ統一。継続フォローの受取登録はoptimistic update＋失敗時ロールバック | 実装済み |
| 押下フィードバック | `.pharmacy-control:active` で scale(0.98)。`:disabled`/`[aria-disabled]` は除外 | 実装済み |
| reduced-motion | `@media (prefers-reduced-motion: reduce)` で全アニメーション・transitionを停止 | 実装済み |
| 下書き自動保存 | `draftStorage.ts` 新設。問診の回答＋ステップ・新規患者フォームを `localStorage` へ保存し、LIFF再起動・セッション切れで復帰。キーは患者ID単位で分離（`intakeDraftKey`/`NEW_PATIENT_DRAFT_KEY`）、送信成功時にクリア。storage不可環境は例外握りつぶしてフォーム自体は継続 | 実装済み |
| 生年月日入力 | 患者登録の `type="date"` を廃止 → 年/月/日の3分割 `inputmode="numeric"` 入力。`birth_date`（YYYY-MM-DD）は派生値のためAPI契約不変 | 実装済み |
| エラーサマリ | `PharmacyErrorSummary` 新設（上部一覧→該当fieldsetへジャンプ＋focus、mount時自動focus）。問診の未回答安全確認（ステップスコープ）とEC送信エラーに導入 | 実装済み |
| 自動再試行 | `usePharmacyAutoRetry`（最大2回、3秒/6秒バックオフ、成功時リセット）を全idempotent loadへ配線：処方せん4系統・問診2系統・timeline・continuity・followup・info・shell初期アクセス。送信/mutationは対象外 | 実装済み |
| iOS自動ズーム防止 | seam内の全 input/textarea/select を `text-base` へ（16px未満inputのフォーカス強制ズーム対策）。radio/checkbox/fileは対象外 | 実装済み |
| コントラスト | `text-gray-500` → `text-gray-600`（空状態・履歴なし表示） | 実装済み |
| 行間 | `.pharmacy-shell/.pharmacy-main` に `line-height: 1.6`（DADS 160%基準）を既定化 | 実装済み |
| 数値入力 | ECの年齢・過去3か月利用回数を `type="number"` → `type="text" inputmode="numeric" pattern="[0-9]*"` ＋非数字除去（スピナー誤操作・スクロール値変化の排除） | 実装済み |
| 回帰ガード | `v036-ui-rules.test.ts` に5規約追加：reduced-motion網羅性、`scrollTo`/`document.title` 存在、`type="number"/"date"`禁止（EC直近月経日は直近日付pickerとして例外許可）、テキスト入力の`text-base`必須、`text-gray-400/500`禁止、spinner使用時の`aria-busy`必須 | 実装済み |

### 差分で確認した安全性

- **PHIとlocalStorage**: 下書きは患者自身の端末内 `localStorage` にのみ保存され、サーバー送信は従来どおり送信操作時のみ。患者ID単位でキーを分離し、家族の別患者へ混入しない。送信成功・別患者選択時はリセットして混入を防止。storageが使えないWebView環境（プライベートモード等）はtry/catchで握りつぶし、フォーム自体は動作し続ける。
- **下書き復帰のマージ順**: 保存済み回答の上に下書きを重ねる（`{...savedAnswers, ...draft.answers}`）。下書き保存後に追加された回答キーがあっても保存値を失わない。
- **自動再試行の境界**: `usePharmacyAutoRetry` はidempotentなload専用。submit/mutationには配線しない設計をコメントで明記し、全呼出箇所がload経路であることを確認済み。失敗カウンタは成功時リセット、最大2回で停止（無限リトライなし）。
- **タブ切替での入力保持**: `PharmacyShell` の再マウントキーはpathnameのみに限定し、query変化ではchildrenをunmountしない（処方せんタブ切替で選択中の患者・写真・同意を失わない）。
- **エラーサマリのフォーカス競合**: 問診サマリは`showErrors`（「次へ」押下後）でのみ表示し、初回マウント時の未回答状態ではfocusを奪わない。ジャンプ先は当該ステップ内に限定（`SAFETY_KEYS_BY_STEP`）。ECの全ジャンプ先ID（10件）は実在を確認済み。
- **遅延読み込みとの競合**: `usePharmacyAutoRetry` のretry callbackは`useCallback`で安定化し、timeoutはunmount/再実行時にclearTimeoutで解除。
- **API契約**: 変更なし。`birth_date`文字列・EC draft・intake answersの送出形式は不変。UI層のみの変更のため、旧LIFFとのlockstep deployは不要。

### レビューで検出・修正した事項

- 下書き復帰のマージが `{...INITIAL, ...draft}` だったため、下書き保存後に追加された回答キーの保存値を失う可能性を `{...savedAnswers, ...draft}` へ修正。
- 一括置換で radio/checkbox/sr-only input にも `text-base` が混入したものを全件除去（非テキスト入力は対象外）。
- ガードテスト新規約が `emergency-last-period` の `type="date"` を誤検出したため、直近日付pickerとして明示例外化。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件を`0.36.1`へ統一 |
| liff | 25 files / 164 tests PASS、`tsc --noEmit` PASS、Vite build成功 |
| 破壊的変更 | なし。API field/routeのrename・削除、schema変更、旧契約の意味変更なし |
| 実LINE受入 / production deploy | NOT_RUN — Human Gate。local greenでは代替しない |

## Pharmacy v0.36.0 (2026-09-17)

> パッケージ／ソースのバージョンを`0.36.0`として確定し、Closed-loop Follow-up & Communication の残件と患者向けUI改善・薬局管理画面の機能追加を`dev`で管理します。ソースコードのタグ`v0.36.0`と販売者向けリリース`pharmacy-v0.36.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

薬局側は、服薬フォローの運用設定（営業時間・応答SLA・主/副担当・時間外/緊急案内）を`GET/PUT /api/custom/pharmacy/medication-followups/operations`と管理画面パネルで読み書きできるようにし、スタッフ対応待ち案件の`response_deadline_at`をアクションキューと日次サマリーの期限超過分類へ乗せました。チャットには承認制の定型文ピッカーを追加し、既存の手動送信composerと`X-Line-Harness-Source: manual`経路を変えずに定型文を挿入できます。患者側はLIFF全画面で本文`text-base`・タップ領域`min-h-11`へ揃え、服薬フォロー回答の送信完了後に対応の見通し（返信目安・時間外/緊急の固定文言）を併記するようにしました。

この版の実装も既存のtenant/account/staff認可、capability、`expectedVersion` CAS、tenant audit、triggerによるstaff scope不変条件、承認済みPHI-freeメッセージ検証を再利用しています。新しいdomain model、AI/OCR、marketplace routing、破壊的schema/API変更は追加していません。

### v0.35.2との差分概要

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| V036-4a 運用設定API | `GET/PUT` operations、`expectedVersion` CAS、同一batchでaudit、capability `medication_followup` 必須、trigger拒否の409/422変換 | 実装済み |
| V036-4b 運用設定画面 | `MedicationFollowUpOperationsPanel`（営業時間・SLA・担当・時間外/緊急メッセージ・有効化トグル、409再取得、二重送信防止） | 実装済み |
| V036-4c 患者表示 | 服薬フォロー回答完了ブロックに対応の見通し（安全な固定文言のみ、SLA内部JSON・staff識別子は非公開） | 実装済み |
| V036-4d 期限超過可視化 | staff対応待ちstatusで`response_deadline_at`をdeadlineとして使用、旧schemaは列検出で`due_at`へfallback | 実装済み |
| V036-7/8/9 LIFF UI | 全12画面監査、本文`text-base`/タップ`min-h-11`統一、送信失敗時の入力保持確認、回帰ガード`v036-ui-rules.test.ts` | 実装済み |
| V036-10 チャット定型文 | additive migration `026_custom_078`、CRUD+承認API（owner/adminのみ・自己承認不可・version CAS・PHI-free強制）、定型文ピッカー（送信経路は不変） | 実装済み |
| V036-11 KPI整合 | ダッシュボードへ「準備完了数」追加、分子/分母注記、`legacyUnscoped`実値バインド、`promiseWithoutReady`構造的ゼロの明示 | 実装済み |
| V036-6 LINE lifecycle | 再follow冪等、重複/再配送(durable inbox)、画像取得失敗（null→`[画像]`fallback / throw→durable retry）、未対応形式、pharmacy postback単一処理、受付≠到達/既読、PHI/provider詳細をlogへ出さない合成テスト7件（follow/unfollowは既存webhookテストで担保） | ローカル完了・実LINE受入はHuman Gate |
| V036-5 release gate | wrong-target/duplicate/PHI通知/PHI log/escalation未対応close/SLA超過放置の各0件を全テストスイートで照合 | ローカル照合済み |
| version contract | runtime package 6件を`0.36.0`へ統一、LIFF version expectation追従 | 実装済み |

### 差分で確認した安全性

- 運用設定のPUTは`expectedVersion` CASとtrigger（staff/account scope・active human staff・enabled未完備拒否）で守り、cross-accountは403/404、stale versionは409、auditはmutationと同一D1 batchで原子的に書きます。
- 定型文は`assertPharmacyAutomatedText`のPHI-free検証を再利用し、placeholder/補間らしい本文を拒否、承認はowner/adminのみで自己承認不可、identity列はtriggerで不変です。送信は既存のmanual composer経路のみで、自動送信経路は作っていません。
- 患者向けoutlookはservice hours text・応答目安・承認済み時間外/緊急メッセージcodeのみを返し、raw SLA JSONや内部staff識別子を出しません。
- LINE lifecycleはAPI受付成功と患者到達/既読を区別し、確認不能を確認済み表示にしません。画像取得失敗は返却`null`で`[画像]`fallback、throwはdurable inbox retryへ委譲し、provider error detailをlogへ残しません。

### レビュー監査（サブエージェント5系統並列）と修正

コミット前にWorker/DB/Web/LIFF/テスト・文書の5エージェントで差分監査を実施。critical/highなし。検出したmedium以下の指摘は全て修正済みです。

- **PHIフェンスの穴を閉塞**: 運用設定の`service_hours_text`（自由テキスト→患者outlookへ表示）に`assertPharmacyAutomatedText`を適用。患者名・薬剤名らしい文言を含む保存を拒否します。
- **サーバー側ロール整合**: `PUT /medication-followups/operations`へowner/adminチェックを追加。UIの「一般スタッフは閲覧のみ」表示とAPI契約を一致させ、一般staffは403を返すテストを追加。
- **migration `026_custom_078` のtrigger/FK強化**: identity immutability triggerに`created_at`を追加。staff-scope triggerが`is_active`・`principal_kind='human'`を検証するよう強化。`created_by_staff_id`/`approved_by_staff_id`に`pharmacy_staff_accounts`へのFKを追加（作成者削除で更新不能になる孤立を防止）。bootstrap.sql/metaを再生成。
- **LIFFガードテストの抜け道を修復**: 行末`<a`の検出漏れ、10行先読みの無関係マークアップ誤免責、`<input>`/inline label未対象、空ファイルのvacuous pass、`pharmacy-control` CSS値未ピンを修正。強化後のガードで実違反6件（`PrescriptionPage`のradio label 2件、EC/questionnaireのテキストリンク4件）を検出し`min-h-11`を適用済み。
- **lifecycleテストハーネスの根本bug修正**: `database()`が呼出ごとにSQL記録をリセットしていた問題を`beforeEach`移動で解消。`fetchImage`呼出・未対応形式4件のmessages_log書込・`first_followed_at`/`created_at`区別をアサート強化。
- **その他**: `?status=all`がarchivedを含むよう修正、`apps/web/tsconfig.tsbuildinfo`をuntrack、PLANSのstale識別子`custom_026`・route inventoryの"approve or reject"表記・CHANGELOG帰属を修正、患者向け表示のASCIIコロンを全角統一。

監査で設計意図と確認し未変更としたもの: 定型文archiveは一般staff可（承認剥奪は職務分離として維持）、outlook判定は`enabled`のみ（staff active再確認は送信側gateの非対称責務）、inlineテキストリンクへの`min-h-11`適用に伴う行高44px化。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件を`0.36.0`へ統一 |
| worker | 262 files / 2,857 tests PASS、typecheck PASS |
| web | 55 files / 264 tests PASS、`tsc --noEmit` PASS |
| liff | 26 files / 158 tests PASS、`tsc --noEmit` PASS |
| packages/db | 99 files / 470 tests PASS |
| scripts | 225 tests PASS（route inventoryへchat-templates登録済み） |
| migration / schema | additive migration `026_custom_078`追加、bootstrap同期済み（`check-migrations.ts` OK） |
| 破壊的変更 | なし。API field/routeのrename・削除、schema drop、旧契約の意味変更なし |
| 実LINE受入 / production deploy | NOT_RUN — Human Gate。local greenでは代替しない |

## Pharmacy v0.35.2 (2026-09-17)

> パッケージ／ソースのバージョンを`0.35.2`として確定し、v0.35系の保守リリースとして`dev`で管理します。ソースコードのタグ`v0.35.2`と販売者向けリリース`pharmacy-v0.35.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

監査キュー`AUDIT-V4-20260916`（40件+独立レビュー指摘）の成果を`dev`へ集約しました。患者向けには、Google Meet個別相談について、登録確定・前日・1時間前の3種類を承認済みの中立テンプレート（日時変数＋参加用Meetリンク）でLINE通知します。通知は新しい`meet_consultation` capabilityで制御し、薬局アカウントでは平文の`channel_access_token`列を使わず、暗号化credentialストア経由の承認済みsenderに一本化しました。処方せん画像の保持は、キャンセル・放置下書き・調剤完了を含む全画像を3年保持へ統一し、物理削除は復旧ゲート付きのretention purgeのみに限定しました。

この版の実装も既存のtenant/account/patient認可、capability、notification ledger、retry key冪等、outbound pause、CASを再利用しています。新しいdomain model、AI/OCR、marketplace routing、破壊的schema/API変更は追加していません。

### v0.35.1との差分監査

比較対象は、v0.35.1のタグ対象`91bf07c`（cutコミット`66832ab`）から、監査v4成果を集約した現在の`dev`（`c109b90`）までです。差分は5コミット、114ファイル、`6,171`行追加、`978`行削除でした。追加行の大半は監査v4のmigration・テスト・証跡文書で、機能コードの縮退ではありません。

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| PR #119 / `91bf07c` | release/v0.35.1 マージ（version contract、LIFF version expectation の0.35.1追従） | 実装済み |
| `54f399e` / PR #120 | Myna sweepのJST quiet-hours整合、rate-limit合成テスト、evidence/PLANS記録更新 | 実装済み |
| `848ac39` | 監査v4堅牢化バッチ: booking冪等性・calendar overlap・meet reminder delivery_id・Stripe effects_completed_at・friend link scope trigger のadditive migration `021`〜`025`、bootstrap同期、I19-R2（全処方箋画像3年保持）、F20（通知sweep回帰の実SQLite化）、独立レビュー修復（chats stale wedge、bootstrap fallback、stripe tenant scope） | 実装済み |
| `c109b90` | F24（Meet相談の承認済みsender接続）、F08（plugin-template自動通知のmanual API誤用修復）、I20-R2（冪等lookupの1query化） | 実装済み |

### 差分監査で確認した安全性

- 新しい通知`meet_consultation_v1`は`buildApprovedPharmacyMessage`の承認済みカタログへ追加され、`meetStatus`（scheduled/day_before/hour_before）・`genericDate`・`genericTime`・`meetUrl`の4変数だけを許可します。`meetUrl`は`https://meet.google.com/...`形式のみ受け付け、他messageIdでの`meetStatus`/`meetUrl`使用は拒否されます。描画結果の照合`isApprovedRenderedPharmacyMessage`も3 variantを検証します。
- senderのcapability対応付けは`meet_consultation_v1`→`meet_consultation`を明示し、`emergency_contraception`等の既存capabilityでは代替できません。capability不在の薬局アカウントでは送信せずfail-closedでfailed記録します。
- Meetリマインドの薬局経路は`isPharmacyModeAccount`判定→`readLineCredential`（暗号化credential、tenant/account/kindスコープ）→`sendPharmacyAutomatedPush`の順で、friend following・tenant active・outbound pause・notification events冪等claimを既存経路で再確認します。`retryKey`は`meet-reminder:{delivery_id}`で、再スケジュール時にdelivery_idを再採番するため前世代との衝突を防ぎます。非薬局アカウントは従来のgeneric経路を維持します。
- 登録確定通知は`POST /api/meet-consultations`でbest-effort送信（`confirmationSent`フィールド追加）。通知失敗でも登録自体はコミット済みで201を返し、重複登録は`ON CONFLICT`で冪等です。
- I19-R2の保持統一では、`cancelPrescription`のCAS・scope・戻り値、`markPrescriptionFileDeleted`のexport、cancel responseの`cleanupPending`フィールド形状をすべて維持し、workflow cleanupをfail-closed no-op化しました。retention-purgeの候補選択は`created_at`ベースでstatus非依存のため、保持された画像は3年後に正規purge対象へ到達します。
- F08のplugin-template修復は、`POST /api/friends/:id/messages`（manual必須・手動返信専用）をやめ、`tag_added`scenario発火型へ変更しました。scenario文面は静的のためper-friend日時はLIFF誘導へ置き換え、triggerタグをdedupマーカーに利用します。
- I20-R2の冪等lookup 1query化は、legacy優先順位とJS側期限判定（legacy expired→scopedフォールスルー）を維持したままdual-readを`UNION ALL`へ統合しました。

### 差分監査の指摘（修正済み・保留）

- **修正済み**: 監査v4キューのBLOCKED 2件（F24: Meet承認文面/capability不在、F08: plugin-template契約）をユーザー承認済み契約で解消。queueは42件中 INTEGRATED 41 / NOT_ADOPTED 1（F03撤回）でBLOCKED 0件になりました。
- **修正済み**: 独立レビュー指摘のIR20-F20-01（回帰テストが実SQL未検証）とI19-R2（cancel画像即時削除 vs 全PHI保持）を解消。
- **保留（既知事項）**: 監査coverageは全領域PARTIALのまま。installer benign-skipのtrigger差異（upstream-only経路）は個別対応見送り。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件を`0.35.2`へ統一 |
| worker | 257 files / 2,815 tests PASS |
| typecheck | 全パッケージ PASS |
| plugin-template | typecheck PASS |
| `git diff --check` | clean |
| migration / schema | additive migration `021`〜`025`追加、bootstrap同期済み（`check-migrations.ts` OK） |
| 破壊的変更 | なし。API field/routeのrename・削除、schema drop、旧契約の意味変更なし |

本エントリはローカル/CI/syntheticの証跡に基づき、release・deploy・activation・production operationの完了を意味しません。

## Pharmacy v0.35.1 (2026-09-15)

> パッケージ／ソースのバージョンを`0.35.1`として確定し、v0.35系の保守リリースとして`dev`で管理します。ソースコードのタグ`v0.35.1`と販売者向けリリース`pharmacy-v0.35.x`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

v0.35.0で導入した共有薬局アカウント・beta参加資格・服薬後follow-up運用の上に、マージ済み8 PRと保守監査キュー`MAINT-20260915`の修正を積み増しました。患者向けには、電子処方箋（Myna）手続きと緊急避妊薬の事前受付について、確認・取消・期限切れの状態遷移を中立な定型文でLINE通知し、服薬後follow-upの対応見通しをLIFFへ表示します。管理画面は各ページに説明文を追加し、ステータス表記を日本語化しました。認証まわりでは、ブラウザ保存領域やCSRFが使えない環境で安全に停止するようにし、webhookの生エラーログを固定event/reasonのPHI-free構造化ログへ置き換えました。

この版の実装も既存のtenant/account/patient認可、capability、notification ledger、retry key冪等、outbound pauseを再利用しています。新しいdomain model、AI/OCR、marketplace routing、破壊的schema/API変更は追加していません。

### v0.35.0との差分監査

比較対象は、v0.35.0のbeta範囲としてfreezeした候補`cc8019d`から、全マージを反映した`dev`（`80bb84e`）までです。差分は39コミット、165ファイル、`3,156`行追加、`14,501`行削除でした。削除行の大半は`docs/upstream/`と古いinventory/計画文書の整理で、コードの縮退ではありません。

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| PR #110 / `87cd33d` | session/CSRFのsafe-stop、LIFF患者切替のstale state防止、support-mode名cacheの非致命化、pharmacy webhook 7分岐のPHI-free固定ログ化 | 実装済み |
| `2e50139` | patient-intake FLE migration helperの原子batch化・account-wide事後条件・opaque cursor（mutating操作は依然gate下） | 実装済み |
| `2b406a5`〜`dcc8bb8` | crypto primitive・ISO日付validator・テスト用sqlite/D1 adapterの共通化 | refactor |
| `95399ed` | UI安定性・44pxタップ領域・`Intl.DateTimeFormat`共有化 | 実装済み |
| PR #111 | `docs/upstream/`とwiki代替済みの設計文書を削除し、docs/README・AGENTSを新構成へ | 文書整理 |
| PR #112 | 管理画面各ページの説明文追加と薬局UIの日本語化（`readiness-labels.ts`共有化） | 実装済み |
| PR #113 | `.devin/blueprint.yaml`（Devin環境blueprint）を追加 | 環境定義 |
| PR #114 | ready状態の処方せんカードへ受取方法の再明示 | 実装済み |
| PR #115 | LIFF服薬後follow-upへ運用設定由来の対応見通し表示（whitelist項目のみ） | 実装済み |
| PR #116 | 患者timelineへ患者アンケート・個別chatの状態を追加 | 実装済み |
| PR #117 | Myna handoffの`SUPPORT_NEEDED`/`PAPER_FALLBACK`/`EXPIRED`へPHI-free定型通知 | 実装済み |
| PR #118 | 緊急避妊薬intakeの`reviewed`/`cancelled`/`expired`へ中立定型通知（JST 21-08 quiet hours付き） | 実装済み |

### 差分監査で確認した安全性

- 新しい通知2系統（`myna_handoff_status_v1`、`emergency_intake_status_v1`）は`buildApprovedPharmacyMessage`の変数allowlistへ追加され、各messageIdは対応するstatus変数1つだけを許可します。描画結果の照合`isApprovedRenderedPharmacyMessage`も全status variantへ拡張され、`UNSAFE_RENDERED_TEXT`の検査は変更していません。送信側はmessageIdを`electronic_prescription`/`emergency_contraception` capabilityへ対応付け、friend following・患者通知設定・beta binding・outbound pauseを既存経路で再確認します。
- retry keyは`myna-status:{handoffId}:{status}`と`emergency-intake-status:{eventId}`の決定的値で、notification eventsの冪等claimで重複送信を抑止します。cron sweepは`updated_at`/`occurred_at`の72時間lookbackと`LIMIT 50`でboundedです。
- `GET /api/liff/pharmacy/medication-followups/outlook`は運用設定のwhitelist項目（営業時間テキスト・boundedな返信目安分数・時間外/緊急メッセージcode）だけを返し、staff IDやSLA生JSONは患者へ出しません。`/:id` GETルートとの衝突はありません。
- 患者timelineの`patient_intake`は`authorityPredicate`と`archived_at IS NULL`を既存domainと同じ形で適用し、`manual_chat`はfriend自身のchat状態だけを中立な`detail_path`へ投影します。
- 認証のsafe-stop化では、storage不可・CSRF欠落・session不正形のとき空token送信や自動POSTを行わず、明示エラーで停止します。e2eモックは厳格化したsession形へ追従済みです。

### 差分監査の指摘（修正済み・保留）

- **修正済み**: `.devin/blueprint.yaml`が`pnpm@9.15.4`をinstallする記述になっていたのを、root `packageManager`の`pnpm@11.25.0`へ揃えました（本リリースコミットで対応）。
- **保留（フォローアップ候補）**: `processExpiredMynaHandoffNotifications`のcron sweepにはJST 21:00–08:00のquiet-hoursガードがなく、深夜に期限切れpushが送信されえます。EC系通知・予約リマインドと同じ深夜抑制の適用を検討してください（patient-report/verification経由の即時通知は利用者・職員操作起点のため対象外）。
- **保留（文書）**: `PLANS.md`の未完了タスク`B41-A3`が削除済みの`docs/pharmacy/GROWTH_LOOP_KPI_CONTRACT.md`を参照しています。タスクの基準文書を再指定する必要があります。歴史記録行中の`V032_ROUTE_API_ROLE_INVENTORY`/`GROWTH_LOOP_ROADMAP`参照は当時の記録としてそのまま保持します。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件を`0.35.1`へ統一 |
| PR #110〜#118 `verify` (CI) | 全てSUCCESS（各headを最新devへ更新後に再実行） |
| `apps/web` e2e `prescription-journey` | 11/11 PASS（ローカル再確認） |
| migration / schema | 新規migrationなし（`custom_077`までの既存セットを維持） |
| 破壊的変更 | なし。API field/routeのrename・削除、schema drop、旧契約の意味変更なし |

本エントリはローカル/CI/syntheticの証跡に基づき、release・deploy・activation・production operationの完了を意味しません。

## Pharmacy v0.35.0 (2026-09-14)

> パッケージ／ソースのバージョンを`0.35.0`として確定し、v0.35のrelease candidateとして`dev`で管理します。ソースコードのタグ`v0.35.0`と販売者向けリリース`pharmacy-v0.35.0`は別のidentityです。本エントリの作成だけでは、`main`への反映、本番環境への配備、薬局アカウントへのbeta適用、実患者データの操作、実際のLINE送信を行いません。

### このバージョンで目指したこと

薬局の管理画面を薬局コード＋パスワードの1つの共有薬局アカウントへ簡素化し、患者本人・正式な代理権がある家族の参加資格を薬局単位でサーバー側管理できるようにしました。薬局職員が確認すべき業務を既存の処方せん・Myna・問診・継続・服薬後follow-upへ安全に戻れる読み取り専用queueへまとめ、服薬後follow-upは対応記録・担当者・期限・送信直前認可を含む閉ループへ拡張しました。

この版の実装は、既存のtenant/account/patient認可、CAS、監査、idempotency、outbound ledger、webhook fencingを再利用しています。新しい患者・処方せん・follow-upの重複domain model、AI/OCR、marketplace routing、オンライン服薬指導、決済、配送、SMS/emailは追加していません。

### v0.34.2との差分監査

比較対象は、タグ`v0.34.2`（`99dd8b2`）から、全ブランチ・ワークツリーを`dev`へ集約した現在の`dev`（`8c0456b`）までです。差分は14コミット、151ファイル、`9,667`行追加、`2,073`行削除でした。main系の取り込み、薬局メニュー／公開プロフィール系の取り込み、release evidenceの追加もこの差分に含まれるため、薬局機能だけの行数とは扱いません。

その後の残存事項監査で行った`019`／`020`、通知再試行・世代束縛の補修、対応テストは、上記統合基準に対する現在の作業treeへ追加しています。コミット済み履歴の統計と、未コミットの追加補修を混同しないように分けて記録します。

| 範囲 | 主な変更 | 判定 |
| --- | --- | --- |
| `d1fbc31` | 公開薬局情報へFAX番号を追加し、DB bootstrap、Worker、Web、LIFF、テストを同期 | 実装済み |
| `af995a4` | 共有薬局認証、beta membership、follow-up closure、follow-up operations、担当者のadditive migration（`014`〜`018`）とDBテストを追加 | 実装済み |
| `d031d54` | 薬局コード＋パスワードの共有ログイン、credential再発行、共有主体、認証監査、Platform Admin連携へ移行 | 実装済み。旧個人ログイン発行は意図的に後方互換なし |
| `8011c63` | 本人／正式な未成年代理家族のbeta参加制御、患者アクセス・通知直前再検証、服薬後follow-upのCAS・idempotency・対応記録・自動送信を追加 | 実装済み。成人家族の代理権は対象外 |
| `49aa9cf` | 薬局業務action queue、処方せん業務画面、遅延・競合・結果不明を扱うsynthetic E2Eを追加 | 実装済み |
| `865868a`〜`6928904` | beta readiness、release evidence、検証記録、`0.35.0`版情報を追加 | 証跡・文書 |
| `0e738bf`、`ac66415`、`e65bbcb`、`8c0456b` | main／関連作業ブランチの履歴を`dev`へ統合 | 統合済み。production反映ではない |

特に変更量が大きい箇所は、readiness evidence（`+1,249`）、follow-up repository（`+631/-52`）、DB bootstrap（`+417/-7`）、beta membership repository（`+385`）、Web処方せんE2E（`+368`）、共有認証migration（`+336`）でした。これらは機能追加・移行証跡・テストデータを含むため、行数だけで品質改善や速度改善を主張しません。

### 差分監査に基づくリファクタリング・バグ修正

- 共有薬局主体の認可判定を`resolveAccessiblePharmacyTenant`へ集約し、tenant/account mapping、active tenant、staff membership、共有主体のtenant bindingを1クエリで確認するよう整理しました。`tenant-boundary`が共有ログインを個人の`pharmacy_staff_accounts` assignmentだけで拒否しないよう、同じ認可経路を再利用しています。
- `staff_members.principal_kind`／`shared_tenant_id`がまだ存在しない旧Worker・旧DBでは、SQLが存在しない列を参照しないlegacy predicateへ縮退するようにしました。現在スキーマの検出結果はDBオブジェクト単位で正の結果だけを短時間再利用し、旧スキーマを誤って共有主体として許可しません。
- 上記の非同期predicate変更に合わせて、chat、conversation、friend、activity digest、unanswered inbox、服薬後follow-upの呼出元を整理しました。旧スキーマ読み取りと、closure列がない状態の既存follow-up遷移を実DB互換テストで確認しています。
- follow-up遷移の担当者省略値を`undefined`とDBの`NULL`で同一視し、同じidempotency keyの再送が不要な競合にならないようにしました。明示した担当者は人間staff・tenant membership・account assignmentまでSQL内で再確認し、担当者が未認可なら対応記録だけが先に残らないようにしました。
- 対応記録の日時は入力を正規化してから、既存idempotency keyの一致確認を先に行うようにしました。新規記録だけ未来日時を要求し、期限経過後の同一payload再送は安全に同じ記録を返します。scheduleの保存後照合には`due_at`だけでなく`response_deadline_at`も含めました。
- 服薬後follow-upの対応履歴GETにPHI view監査（`phi.medication_followup_contacts_viewed`）と`Cache-Control: private, no-store`を追加しました。既存の患者・アカウント境界を通過した後だけ監査と返却を行います。
- beta membershipの通知判定を`active`／`suspended`／`blocked`へ分離しました。停止中は送信せず、外部送信前のledgerは`attempted`のまま保持して同じretry keyで再試行します。期限切れ・取消・不正日時・認可DB読取失敗はfail closedとし、bindingの一時読取障害だけは恒久blockedにしません。
- Webのfollow-up画面で、既存の意味ある対応記録がある`responded`行を、画面上の新しい入力がないことだけで送信不能にしないよう条件を修正しました。
- action queueの東京日付判定で毎回`Intl.DateTimeFormat`を生成せず、formatterを1つ再利用するようにしました。Node 26.6.0／SQLite 3.53.4、同一synthetic rows、warmup 3回・測定25回の比較では、7行の中央値`1.012ms→0.065ms`、70行`23.414ms→1.074ms`、357行`164.289ms→7.187ms`となり、返却内容は一致しました。
- 認可拒否ログのroute値をHonoのroute templateへ変更し、患者ID・friend IDなどclient-controlledなpath identifierを一般のauthzログへ複写しないようにしました。

### 残存事項レビューと追加補修（2026-09-14）

差分監査後に、Astraへ旧schema互換、認可・競合、通知・beta、Web・性能の4観点を分離して読取り専用レビューさせました。主担当が各指摘を現行の呼出元・依存先・合成データで再確認し、実装可能な不具合だけを最小差分で補修しました。Astraはコードを変更・commit・pushしていません。

- `019_custom_076_pharmacy_followup_operations_scope.sql`を追加し、`pharmacy_medication_followup_operations`のinsert/update時に、主担当・代行担当が対象tenantのstaff membershipと対象薬局accountのstaff assignmentへ属することをSQLite triggerで強制しました。`enabled=1`へ切り替える場合は、tenant/accountのmembership・assignmentがactiveで、staffの`principal_kind`が`human`であることもDB側で確認します。無効状態の事前設定とnullableな代行担当は許可し、既存行の削除・backfillは行いません。
- `packages/db/test/custom_076_pharmacy_followup_operations_scope.test.ts`で、cross-tenant主担当のinsert、cross-tenant代行担当とaccount変更のupdate、無効staffの事前設定、active human staffへの切替、nullable backup、4 triggerの存在を合成SQLiteで確認しました。update-engineの固定migration manifest、bootstrap SQL/meta、既存DBテストのmigration期待値も同期しました。
- `020_custom_077_pharmacy_beta_notification_bindings.sql`を追加し、処方せん状態、服薬後follow-up、継続期待、処方せん期限通知の既存retry keyへ、作成時点の`membership_id`・participant・subjectを不変に束縛しました。beta有効時の各source INSERT／患者リンク／validity更新でactiveまたはsuspended世代だけを記録し、取消→再付与後も古いqueueを新しいmembershipへ自動backfillしません。送信側は束縛IDを受け取れない場合、または同一IDが期限切れ・取消・対象不一致の場合にfail closedします。
- `packages/db/test/custom_077_pharmacy_beta_notification_bindings.test.ts`で、4通知sourceの作成時束縛、患者リンク後のstatus event束縛、beta無効時の非backfill、取消→再付与後の旧ID保持、bindingのupdate/delete拒否を合成SQLiteで確認しました。既存retry key、`sent`／`attempted`／結果不明のledger意味は変更していません。
- 送信直前のWorker再検証は残し、DBへ直接書き込まれた古い不正行や、担当者の失効・停止を送信時に再度fail closedできる二重防御としました。業務設定の書込みAPIは現行コードから確認できなかったため、新しい運用APIは追加していません。
- `pnpm-workspace.yaml`の狭いparent overrideで、開発audit経路の`undici`を`7.29.0`、Wrangler/miniflare経路の`sharp`を`0.35.4`へ固定し、lockfileを更新しました。無関係な一括upgradeは行わず、`pnpm audit`（全依存・production依存）はともに既知の脆弱性`0`件になりました。
- 重複配信previewの全呼出元をdynamic importへ揃え、Worker buildの`INEFFECTIVE_DYNAMIC_IMPORT`警告を除去しました。HLS chunkは既に遅延ロードされており、実測なしの分割は行わず、現在のbuild警告はWorker/LIFFのHLS `574.61 kB`だけです。
- 追加した`019`／`020` migrationと合成testをgitleaksで個別走査し、検出0件でした。参考としてWorker/DBソース全体では既存test fixtureの固定値19件がgeneric-api-keyとして検出されましたが、いずれもsynthetic dataで実credentialではないため、値を外部へ出さず、今回の差分へ混入させていません。
- Astraが再確認したmembership世代の未束縛は、`020_custom_077_pharmacy_beta_notification_bindings.sql`と共通senderのexact-ID再検証で補修しました。停止中に作成されたqueueは同じmembership IDへ束縛してretryableにし、取消後に再付与された新IDへ旧queueを付け替えません。成人家族の正式代理権は、本人確認方法、証跡の保持、許可する操作、期限・取消・複数代理人の扱いが未定のため、家族関係文字列だけで権限を拡張していません。
- 追加実装レビューで確定した5件も補修しました。患者リンク後のstatus eventは同一submissionかつevent作成時点のmembershipだけを束縛し、期限通知triggerはbeta有効時だけ動作します。停止中の初回status通知はmembership再開後に再発見し、外部送信前に停止・運用未設定となったattempted行は結果不明の意味を保ちます。bindingの一時読取障害は`blocked`へ固定せず上位の再試行へ返します。
- 今回の追加ファイルは、ユーザーが明示承認したOracle送信allowlist（`014` migrationとそのtest）の対象外です。新規ファイルをOracleへ送信せず、Oracleの追加実装レビュー結果を成功扱いにしていません。

### 多角的レビューで確認した未変更項目

4本のread-only Astraレビュー（旧スキーマ、認可・競合、通知・beta、Web・性能）を別々の観点で実施し、指摘は上記の確定修正または以下の保留へ分類しました。Astraはコードを変更・commit・pushしていません。

- `patientId`を省略する既存処方せん受付と、患者IDを持たない既存通知は、既存利用者の処理を維持する現行計画と衝突するため変更していません。患者subject単位のbeta必須化へ変更する場合は、別途API契約と旧クライアント受入を定義します。
- `pharmacy_followup_operations`のstaff foreign keyは単一列ですが、追加migration `019_custom_076_pharmacy_followup_operations_scope.sql`のscope triggerで、tenant membershipとaccount assignmentのcross-tenant不整合をDB insert/update時に拒否するよう補修しました。Workerの送信直前再検証も維持しています。
- notification expectation／retry jobの世代束縛は`020_custom_077_pharmacy_beta_notification_bindings.sql`で追加しました。既存retry keyを変えずに、source生成時の不変bindingを参照し、beta有効時にbindingなしの旧queueを送信しません。古いWorkerがこの追加bindingを解釈できない混在状態ではbeta通知を有効化しない運用ゲートが必要です。
- 成人家族の正式代理権は、本人確認・代理権証跡・許可操作・期限／取消の運用契約が未確定のため、既存の未成年proxy以外へ拡張していません。
- 依存関係は狭いoverrideでaudit対象経路を更新し、全依存・production依存とも既知の脆弱性0件を確認しました。今後も無関係な一括upgradeは行いません。

### 薬局職員・Platform Admin向けの変更

- 患者向け公開薬局情報へFAX番号を追加し、Worker、Web、LIFF、bootstrap、保存・表示バリデーションを同じfield契約へ揃えました。電話番号と同様に許可文字を限定し、公開情報欄へ患者情報や内部メモを入力しない注意を維持します。
- 薬局画面のログイン入力を薬局コード＋パスワードだけに統一し、ログイン後は薬局の共有主体`pharmacy_shared`として有効な薬局accountへ入るようにしました。
- 旧来の個人tenant-admin credentialを新規発行する経路、tenant admin bootstrap、tenant owner向けCLI session発行を`410`で終了しました。既存の個人ログインを隠し補完したり、先頭のownerを自動選択したりしません。
- 初回発行と忘失時の再発行はPlatform Adminの専用操作へ分離し、共有credentialのtenant、薬局コード、admin membership、account assignment、sessionをサーバー側で束縛しました。
- 認証成功・失敗、パスワード変更、credential発行・再発行を、パスワード・token・患者情報を含まない認証監査へ記録します。credentialの無効化・version変更では未失効sessionを残しません。
- 共有主体を任意のstaffへ再割当できないよう、staff、credential、membership、account assignment、sessionの再利用・identity変更をDB制約とtriggerで防ぎます。
- 管理画面のstaff・tenant・認証ログ表示を、新しい共有ログインと監査の契約に合わせました。パスワードやsecretの画面・CLI出力は行いません。

### 患者本人・家族代理・beta参加資格

- `015_custom_072_pharmacy_beta_memberships.sql`で、薬局account×参加者×対象患者単位の期限付きmembershipを追加しました。betaは既定OFFで、無断の招待・自動登録・自動再開・自動更新は行いません。
- owner/adminだけが同一tenant・accountのmembershipを一覧、登録、停止、再開、取消できます。状態変更は`expectedVersion` CAS、期限、理由、tenant監査、同一batchの原子性を確認します。
- betaが有効な場合、患者向けintake、処方せん、継続、服薬後follow-up、Myna、患者timeline、LIFF feature access、通知送信直前で現在のmembershipを再検証します。古いsession・job・webhookや失効済みproxyからの再開を許可しません。
- 本人利用と、既存の正式な未成年proxyに紐づく家族利用を実装対象にしました。成人家族は、本人確認・正式な代理権証跡・薬局の運用担当が未確定のため、`403`で閉鎖しています。家族を含むbeta要件を、家族関係の文字列だけで満たしたことにはしません。
- privacy撤回、proxy取消、通知停止、binding隔離などのcontrol pathと、薬局職員のaccount-scoped readはbeta参加資格の単純な一括拒否で隠さず、既存の安全な継続経路を維持します。

### 薬局業務画面

- `GET /api/custom/pharmacy/action-queue`を追加し、処方せん、Myna、問診、継続、服薬後follow-up、緊急避妊薬、未対応chatから対応候補をbounded unionで取得します。各domainと全体に上限を設け、部分失敗を他domainの成功と分けて表示します。
- action queueの返却値はdomain、PHI-free status、deadline区分、既存detailへの導線だけに限定し、患者名、LINE ID、record ID、自由記述、問診本文、復号値、assign/status mutationを含めません。
- 処方せんdetailへ、画像・期限・問診更新時刻・受取希望・過去event・受付回答を既存のauthorization/CAS/auditで確認できる導線を追加しました。
- account切替や遅いdetail応答で前の患者を表示し続けないようにし、stale response、409競合、503結果不明、未保存入力、印刷・再撮影の復旧を明示します。
- Webのsynthetic Playwright E2Eで、遅延detail、薬局account切替、競合保存、結果不明、既存recordへ戻る導線を確認できるようにしました。

### 服薬後follow-upと通信安全

- `016_custom_073_pharmacy_medication_followup_closure.sql`で質問票version、一次返信期限、電話／LINE対応記録を、`017_custom_074_pharmacy_followup_operations.sql`で営業時間・SLA・主担当・代行担当などの運用設定を、`018_custom_075_pharmacy_medication_followup_assignments.sql`で明示的な人間担当者を追加しました。
- 既存follow-upのstate、event、CAS、idempotency、notification ledgerを再利用します。`concern`、`pharmacist_requested`、`escalated`から、対応記録なしに`closed`へ進めません。電話対応をLINE対応として記録しません。
- `responded`／`closed`に必要な対応記録が存在しない旧schemaでは、既存の読み取り・既存状態遷移を維持し、追加の期限・対応記録を必要とする経路だけを`503`で停止します。新列・新tableの欠落を「beta無効」と誤認して認可を緩めません。
- 自動通知はapproved PHI-free template、固定retry key、既存ledgerを使います。account、tenant、friend/following、capability、患者認可、対象state、運用設定、outbound pauseをenqueue後・claim後・送信直前に再確認します。
- 営業時間・一次返信期限・主担当・代行担当は未定のため、運用設定を有効化せず、自動follow-up送信は`operations_blocked`でfail closedにします。電話・店頭などの代替対応は、LINE送信成功とは別の記録です。
- 手動の1対1返信だけに`X-Line-Harness-Source: manual`を付け、自動送信へ付与しません。実LINEの到達・既読、LINE側自動応答との重複、結果不明の照合は外部受入で別途確認します。

### データベース移行

| migration | 内容 |
| --- | --- |
| `014_custom_071_shared_pharmacy_auth.sql` | `pharmacy_shared`主体、共有credential、auth audit、session・assignment・identity再利用防止、無効credentialのsession失効を追加 |
| `015_custom_072_pharmacy_beta_memberships.sql` | 薬局account単位のbeta flag、participant×subject membership、期限・状態・CAS・監査を追加 |
| `016_custom_073_pharmacy_medication_followup_closure.sql` | follow-up質問票version、一次返信期限、電話／LINE対応記録を追加 |
| `017_custom_074_pharmacy_followup_operations.sql` | 営業時間、response SLA、primary/backup、営業時間外・緊急時のfail-closed運用設定を追加 |
| `018_custom_075_pharmacy_medication_followup_assignments.sql` | follow-up eventと対応経路へ明示的な人間担当者を追加 |
| `019_custom_076_pharmacy_followup_operations_scope.sql` | follow-up運用の主担当・代行担当をtenant membership、account assignment、active human staffへDB側で束縛 |
| `020_custom_077_pharmacy_beta_notification_bindings.sql` | beta対象の通知sourceと既存retry keyを作成時membershipへ不変束縛し、取消後の新世代への旧queue再生を防止 |

全migrationはadditiveです。bootstrap SQLを再生成し、既存table・route・API fieldのrename/dropや、本番データのbackfill・削除は行いません。ログイン契約だけは、ユーザー確定要件に従い旧個人ログイン発行との後方互換を持たせず、旧発行経路を`410`で閉じています。

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| version contract | runtime package 6件、CHANGELOG、LIFF version contractの`0.35.0`統一／2 tests PASS |
| `pnpm verify:ci` | 10 test suite／合計4,058 tests PASS、全workspace typecheck PASS |
| frozen lockfile install | `pnpm install --frozen-lockfile --ignore-scripts` PASS |
| `packages/db` unit／integration test | `92 files / 436 tests PASS` |
| `packages/line-sdk` test | `2 files / 5 tests PASS` |
| `packages/sdk` test | `13 files / 56 tests PASS` |
| `packages/mcp-server` test | `5 files / 19 tests PASS` |
| `packages/update-engine` test | `22 files / 219 tests PASS` |
| `packages/create-line-harness` test | `8 files / 61 tests PASS` |
| `apps/worker` test | `247 files / 2,654 tests PASS` |
| `apps/web` test | `52 files / 242 tests PASS` |
| `apps/liff` test | `24 files / 148 tests PASS` |
| scripts test | `21 files / 218 tests PASS` |
| workspace typecheck | `PASS`（全workspace） |
| workspace build | `PASS`（`pnpm build`、Webはsynthetic `NEXT_PUBLIC_API_URL`） |
| migration checker | `19 post-baseline migrations PASS`（baselineを含む全20 migration） |
| bootstrap generator／`git diff --check` | `PASS` |
| production dependency audit | 既知の脆弱性`0`件 |
| production license baseline | `unknown/unlicensed` group `0` |
| CycloneDX SBOM | spec `1.6`／`208 components`、構造確認 PASS |
| release変更対象のsecret scan | `gitleaks git --log-opts=v0.34.2..HEAD`で10 commitsを走査、検出`0`件 |
| 追加ファイルのsecret scan | `019`／`020` migration／testは検出`0`件。Worker／DB全体の19件は既存synthetic test fixtureのgeneric-api-key誤検出 |
| 全依存を含むaudit | 既知の脆弱性`0`件（`undici`／`sharp`は狭いoverrideで修正） |
| LIFF Chromium E2E | synthetic `13 tests PASS` |
| Web Chromium E2E | synthetic `11 tests PASS` |
| build warning | build自体はPASS。Worker／LIFFでHLS `574.61 kB` chunkのみ。`INEFFECTIVE_DYNAMIC_IMPORT`は解消 |
| 実LINE、実スタッフ・実端末、iOS／Android WebView、VoiceOver／TalkBack、Meet、SMS/email | `NOT_RUN` |

### リリース境界と未完了ゲート

- `dev`の直接pushはGitHub保護ブランチにより許可されず、PRと必須check `verify`を必要とします。今回の版確定はローカル候補のversion/changelogであり、remoteへの直接反映とは別です。
- Oracle実装レビューは、ユーザーが送信を承認した`packages/db/migrations/014_custom_071_shared_pharmacy_auth.sql`と`packages/db/test/custom_071_shared_pharmacy_auth.test.ts`の2ファイルだけを対象に試行しましたが、別セッションのprofile lockで`NOT_RUN`です。今回の追加リファクタリング対象は許可済みallowlist外のためOracleへ送信していません。添付外のコードは送信していません。
- beta activation、production migration、production deploy、seller release、main merge、実患者データ、実LINE送信はこの版の作業に含めません。
- 成人家族の代理権証跡、営業時間・一次返信期限・主担当・代行担当、実スタッフ／実端末受入、LINE到達／既読と結果不明の受入は未完了です。未完了のため、`0.35.0`を外部beta開始可能とは判定しません。
- seller releaseはソースpackage versionと分離した`pharmacy-v0.35.0`として、V035の全Human Gateとrelease checkがPASSした後に扱います。外部限定beta開始版はロードマップどおり`v0.40.0`です。

## Pharmacy v0.34.2 (2026-09-03)

> 公開範囲: パッケージ／ソースのバージョン`0.34.2`を`dev`向けに公開し、development環境へ配備します。ソースコードのタグ`v0.34.2`と販売者向けリリース`pharmacy-v0.34.2`は別物です。`main`への反映、本番環境への配備、薬局アカウントへの機能適用、実患者データの操作、実際のLINE送信は含みません。

### 依存関係と開発基盤

- 全workspaceの直接依存40種をnpm registryの`latest`へ更新し、pnpmを`9.15.4`から`11.25.0`、TypeScriptを`5.9.3`から`7.0.2`へ更新
- Next.js `16.3.4`、Vite `8.2.2`、Wrangler `4.128.0`、Hono `4.13.5`、LINE LIFF SDK `2.31.0`、hls.js `1.7.2`へ更新
- Zod `4.5.4`、`@noble/hashes` `2.4.0`、`tar-stream` `3.2.1`などのruntime依存と、React／Node型定義・Cloudflare toolingを更新
- GitHub Actionsを最新リリースと照合し、CodeQL、GitHub Pages、checkoutを含む全参照をcommit SHAへ固定
- pnpm 11のworkspace設定へsecurity overrideとnative build許可を移し、追跡対象のnpm lockfileも現在のmanifestへ同期

### TypeScript 7互換

- `tsup`のTypeScript 7非互換な型宣言bundleを使わず、既存の`tsc`で宣言ファイルを生成
- update engineのNode型依存を明示し、`tar-stream`のdata chunk型をruntime契約に合わせて保持
- SDK、update engine、plugin templateの公開entryに必要なJavaScriptと型宣言が生成されることを確認

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| registry latest照合 | 直接依存40種、差分0件 |
| production dependency audit | 既知の脆弱性0件 |
| 全workspace | `verify:ci`、3,986 tests PASS |
| 全workspace build | Worker、Admin、LIFF、packages PASS |
| LIFF browser smoke | Chromium 13 tests PASS |
| migration contract | post-baseline 12 migrations PASS |
| main／production配備、seller release、実LINE操作 | `NOT_RUN` |

### 変わらない安全条件

- API、DB schema、migration、患者データ、LINE送信処理の契約は変更しない
- dependency更新とdev source releaseを、未完了の実端末・支援技術・低速通信・参加者試験の代替証拠にしない
- dev source releaseとdevelopment deployが成功しても、`pharmacy-v0.34.2` seller releaseやproduction readinessの証拠にはしない

## Pharmacy v0.34.1 (2026-09-03)

> 公開範囲: パッケージ／ソースのバージョン`0.34.1`を`dev`向けに公開し、development環境へ配備します。ソースコードのタグ`v0.34.1`と販売者向けリリース`pharmacy-v0.34.1`は別物です。`main`への反映、本番環境への配備、薬局アカウントへの機能適用、実患者データの操作、実際のLINE送信は含みません。

### セキュリティ修正

- MCP serverが`@modelcontextprotocol/sdk`とExpressを通じて利用する`qs`を`6.15.3`から`6.16.0`へ更新
- bracket形式のquery parameterで配列上限を回避できるDoS脆弱性（CVE-2026-82562 / GHSA-x5fp-wj9c-mxmx）を解消
- 攻撃者が制御する`constructor.isBuffer`によって例外を発生させられるDoS脆弱性（CVE-2026-82417 / GHSA-4mjr-xmp4-gh2g）を解消
- 既存のpnpm override方式を再利用し、MCP server、plugin template、SBOM生成を含む全経路で修正版を固定

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| production dependency audit | 既知の脆弱性0件 |
| MCP server | 5 files / 19 tests PASS |
| 全workspace | `verify:ci` PASS |
| migration contract | post-baseline 12 migrations PASS |
| main／production配備、seller release、実LINE操作 | `NOT_RUN` |

### 変わらない安全条件

- API、DB schema、migration、患者データ、LINE送信処理は変更しない
- v0.34.0で未完了のEC開示方針、実端末・支援技術・低速通信・参加者試験のHuman Gateを完了扱いにしない
- dev source releaseとdevelopment deployが成功しても、`pharmacy-v0.34.1` seller releaseやproduction readinessの証拠にはしない

## Pharmacy v0.34.0 (2026-09-03)

> 公開範囲: パッケージ／ソースのバージョン`0.34.0`を`dev`向けに公開し、development環境へ配備します。ソースコードのタグ`v0.34.0`と販売者向けリリース`pharmacy-v0.34.0`は別物です。`main`への反映、本番環境への配備、薬局アカウントへの機能適用、実患者データの操作、実際のLINE送信は含みません。

### このバージョンで目指したこと

患者がLINE内で「これまでの状況」と「次にすること」を安全に確認でき、通信が途切れた場合も処方せんを重複送信しにくい導線を追加しました。同時に、薬局管理者のログイン、患者本人と家族代理の権限、同意・通知設定、誤ったLINE紐付けの復旧を、テナントとLINEアカウントの境界を越えない形で強化しました。

### 利用者ごとの変更とメリット

| 利用する人 | v0.34.0で変わること | メリット |
| --- | --- | --- |
| 患者 | 薬局LIFFに「利用状況」を追加し、処方せん、電子処方せん、継続支援、服薬後フォローを新しい順に表示 | 薬剤名や問診内容を一覧へ出さず、現在の状態と次に開く画面を確認できる |
| 処方せんを送る患者・家族 | 本人／家族の選択、画像ごとの再試行、送信準備・薬局確認待ち・受付済みを区別 | 通信切断や画面再読込後に、結果不明の送信を盲目的に繰り返しにくくなる |
| 未成年患者の保護者 | 未成年の家族登録時に、対象・利用目的・期限を確認して代理権限を発行し、本人側から取り消し可能 | 家族関係だけで恒久的な閲覧・入力権限が付くことを防げる |
| 患者本人 | 個人情報同意の撤回・再同意、患者単位の通知停止・再開、現在のアクセス状態をLIFFで確認 | 過去記録を破壊せず、新規入力や将来通知を本人の操作で止められる |
| 薬局職員 | 誤ったLINEアカウントへ患者を紐付けた場合、対象を隔離して正しい利用者に再登録を案内 | 古い患者所有者を書き換えたり臨床記録をコピーしたりせず復旧できる |
| owner/admin・Platform admin | セッション期限、アイドル失効、ログイン試行制限、ブラウザorigin、共通パスワード拒否を強化 | 盗用セッション、総当たり、別サイトからのログイン、推測しやすい初期資格情報のリスクを減らせる |
| 運用・開発担当 | development／productionのCloudflare設定を明示的に分離し、既存bindingを保持する検証を追加 | 誤ったD1・R2・Pagesへ配備する事故や、配備時の既存設定消失を防ぎやすくなる |

### 患者向け「利用状況」

- 既存の処方せん、電子処方せん、継続支援、服薬後フォローを、最大50件のread-only projectionとして新しい順に表示
- APIはLIFFの認証済みLINE identityから患者本人と`line_account_id`をサーバー側で解決し、query parameterを権限として使用しない
- 一覧へ出す情報をdomain、許可済みstatus、サーバー定義の次の操作、発生日時、既存detail routeに限定
- patient/friend ID、患者名、薬剤名、処方内容、問診回答、staff note、暗号化payloadを返さず、一覧表示のための復号や更新を行わない
- 別の所有者のrecordは表示せず、未知の内部statusは詳細確認へ安全に縮退
- 緊急避妊薬の利用有無は機微性が高く、中立な遷移先と開示方針が承認されるまでタイムラインへ表示しない

### 処方せん送信と通信切断からの回復

- 本人／家族の選択、患者アンケート完了、画像、同意、通信状態、結果不明の送信を確認してから送信可能にする
- 画像単位と受付単位のidempotency keyを使い、二重tap、timeout、再読込後の重複登録を抑止
- 「送信準備中」「受付内容の確認待ち」「受付済み」を分け、患者端末から届いたことと薬局が受け付けたことを混同しない
- upload結果が不明な場合は自動で成功・失敗を決めず、受付状況の再確認または不足画像の再選択へ案内
- 処方せん画像や問診回答などのPHIを`localStorage`、`sessionStorage`、`IndexedDB`へ保存しない

### 患者本人・家族代理・同意の権限管理

- 家族関係や同意表示だけをアクセス権限にせず、現在有効な`patient_intake_v1`代理grantを患者・LINEアカウント・操作主体へ固定
- 未成年の子どもに限り、固定された同意文面の版とSHA-256を確認して代理grantを発行
- 代理権限の期限は「発行から90日」と「18歳到達」の早い方とし、アクセスのたびに失効・取消・年齢を再確認
- 代理利用者による患者本人の氏名・生年月日変更、患者archive、個人情報同意変更、通知設定変更を禁止
- 患者本人による代理権限の即時取消と、同じ依頼の安全な再実行に対応
- 個人情報同意を撤回した場合は既存の認可済み履歴を保持しつつ、新しい問診revisionを停止。現在の薬局文面へ再同意した後だけ再開

### 通知停止と誤紐付け復旧

- 患者本人が患者単位で将来の自動通知を停止・再開できるCASとLIFF操作を追加
- 処方せん状態、期限、継続支援、服薬後フォローは、送信claim時とLINE dispatch直前に現在の通知権限を再確認
- 停止中の通知は再開後に古い内容を再送せず、送信しなかった結果を台帳へ確定
- 通知設定は個人情報同意、代理権限、患者紐付け状態を暗黙に変更しない
- 誤ったLINE紐付けは担当アカウント権限を持つstaffだけが`wrong_line_binding`理由で隔離可能
- 復旧では旧所有者や臨床記録を変更せず、正しいLINE利用者が既存の本人／未成年登録フローから新規登録

### 管理者ログインと資格情報

- 通常セッションを最長8時間・アイドル15分、初期設定セッションを最長30分・アイドル10分に制限
- tenant adminとPlatform adminのログイン失敗をD1へ保存し、1秒、2秒、4秒の待機後、15分間のlockへ移行
- ログインIDをUnicode NFKC・trim・小文字化して試行制限を共有し、Worker再起動後も制限を維持
- 設定済みAdmin originと同じoriginからのログインだけを許可し、未知のbrowser originやLIFF originからの管理者ログインを拒否
- Unicode code point単位のパスワード長検証と、固定した100,000件のcommon-password blocklistをWorkerとAdmin UIで共通適用
- 初回Platform／tenant admin CLIの必須値、HTTPS origin、再実行キー、ランダム仮パスワード、安全なエラー表示を共通化

### 配備、更新、後方互換

- production Worker buildでproduction用D1・R2を選び、`--keep-vars`で既存のprovision済み変数を保持
- production LIFFは固定したPages projectと`main` branchだけを対象にし、dev projectの暗黙利用を防止
- production dry-runを引数不要の専用scriptに分け、引数転送ミスによる実deployを防止
- migrationは`custom_066`〜`custom_070`を加算し、既存table・column・route・API fieldを削除・renameしない
- 旧Workerが追加columnを無視でき、旧形式の患者・問診insertが継続するexpand/default/fallback契約をテスト
- fresh cloneの検証前に必要なshared packageをbuildし、過去のローカル`dist`へ依存しないCIへ変更

### 動作速度とコード整理

- 低頻度の緊急避妊薬画面をReact標準のlazy loadingへ分離し、LIFF初期main JavaScriptを153,100 bytesから146,332 gzip bytesへ4.42%削減
- DB bootstrapのローカル反復中央値を122.202msから69.182msへ短縮。remote D1や実端末の速度改善とは扱わない
- 薬局CLIの入力検証・再実行キー・仮パスワード・URL検証・安全な表示を共通化
- LIFFの東京日時表示、Webイベント枠のJST→UTC変換、Worker予約のactive LIFFアカウント解決を既存経路間で共通化
- tenant/account authorization、通知、API、schemaの意味を変えず、全体refactorで157行追加・192行削除

### データベース移行

| migration | 内容 |
| --- | --- |
| `custom_066` | admin sessionの種別、activity、失効判定を加算 |
| `custom_067` | tenant／Platform adminの永続login throttleを加算 |
| `custom_068` | 患者代理grantと患者owner controlを加算 |
| `custom_069` | PHIを含まない患者control auditを加算 |
| `custom_070` | 未成年代理登録・取消の整合性と重複防止を加算 |

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| 全workspace unit test | 9 projects / 3,759 tests PASS |
| 配備・運用script test | 20 files / 227 tests PASS |
| TypeScript | 全workspace typecheck、Web／LIFF直接typecheck PASS |
| migration contract | post-baseline 12 migrations PASS |
| LIFF browser smoke | Chromium 13 tests PASS |
| ローカル表示監査 | 390px、200% text、keyboard focus、44px操作領域、axe-core A/AA PASS |
| iOS／Android LINE WebView、VoiceOver／TalkBack、低速通信、参加者試験 | `NOT_RUN` |
| developmentへのpush・配備・runtime read-back | リリース処理で実施・確認 |
| main／production配備、seller release、実LINE操作 | `NOT_RUN` |

### 変わらない安全条件と既知の未完了項目

- タイムラインの緊急避妊薬表示はHuman Gate完了まで非表示を維持
- 実端末・支援技術・低速通信・参加者試験が未実施のため、v0.34患者critical journey全体のproduction readinessは`BLOCKED`
- 自動通知はPHIを含まない承認済みtemplateだけを使用し、薬剤師の判断を自動化しない
- 本番DB migration、既存データ補完、production deploy、薬局アカウント有効化、実患者データ、実LINE送信は別途Human Gateを必要とする
- dev source release、development deploy、`v0.34.0` GitHub Releaseが成功しても、`pharmacy-v0.34.0` seller releaseやproduction運用の証拠にはしない

## Pharmacy v0.33.2 (2026-08-31)

> 公開範囲: パッケージ／ソースのバージョン`0.33.2`を`dev`向けに公開します。ソースコードのタグ`v0.33.2`と販売者向けリリース`pharmacy-v0.33.2`は別物です。`main`への反映、本番環境への配備、薬局アカウントへの適用、DB操作、実患者データの操作、実際のLINE送信は含みません。

### このバージョンで目指したこと

薬局が独自の個人情報利用目的をまだ登録していない初期状態でも、患者がアンケート画面で利用目的を確認し、安全に送信できるようにしました。

### 患者向けアンケート

- 有効な薬局アカウントに利用目的の登録がない場合、患者受付、調剤・服薬指導、医療保険事務、必要な連絡に限定した標準文言を自動表示
- 問い合わせ先は架空の電話番号やメールアドレスを作らず「当薬局へお申し出ください」と案内
- システム運営事業者への委託範囲と、薬局が委託先を監督することを表示
- 標準文言には固定の版番号と内容ハッシュを割り当て、患者が確認した文面をアンケート回答へ記録

### 変わらない安全条件

- 標準文言を薬局職員が作成した設定としてDBへ保存せず、架空の担当者や`updated_by`を作らない
- 存在しない薬局アカウントには標準文言を返さず、別アカウントの設定へ切り替えない
- 薬局owner/adminが独自文言を登録した場合は、その文言を標準文言より優先
- 患者の画面表示後に薬局側の文言が登録・変更された場合は、送信時の版番号と内容ハッシュの再確認で停止し、古い同意内容のまま保存しない
- migration、DB schema、患者データ、LINE送信処理は変更しない

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| privacy policy / patient intake database tests | 9 tests PASS |
| Worker privacy policy / patient intake / provisioning tests | 69 tests PASS |
| 標準文言の固定SHA-256 | `df7e30e12108c2e4fd8e568ba7d47e753fae5aa71f28273c87c562d92486e6fc` |
| 本番環境への配備・DB操作・LINE操作 | `NOT_RUN` |

## Pharmacy v0.33.1 (2026-08-31)

> 公開範囲: パッケージ／ソースのバージョン`0.33.1`を`dev`向けに公開します。ソースコードのタグ`v0.33.1`と販売者向けリリース`pharmacy-v0.33.1`は別物です。`main`への反映、本番環境への配備、薬局アカウントへの適用、DB操作、実患者データの操作、実際のLINE送信は含みません。

### CHANGELOGの修正

- v0.33.0で実際に変更された内容を、過去版と同じ「目的、利用者別、機能別、安全条件、確認状況」の構成で日本語化
- コミット履歴に含まれていたGoogle Calendarの終日予定・空き枠判定、MCP APIの安全化、シナリオタグの取得状態を追記
- ソースコードのタグ、販売者向けリリース、開発環境への配備、本番運用を、それぞれ別の実績として明記

### 変更しないもの

- アプリケーションの動作、API、データベース構造、migration、dependencyは変更しない
- 既存の`v0.33.0`タグとGitHub Releaseは変更しない
- v0.33.0の本番未実施項目とHuman Gateを維持

## Pharmacy v0.33.0 (2026-08-31)

> 公開状況: パッケージ／ソースのバージョン`0.33.0`はPR #97で`dev`へ取り込まれ、ソースコードのタグ`v0.33.0`を作成しました。販売者向けリリース`pharmacy-v0.33.0`とは別物です。`main`への反映、本番環境への配備、薬局アカウントへの適用、実患者データの操作、実際のLINE送信は含みません。

### このバージョンで目指したこと

薬局ごとのLINE運用量を患者情報なしで確認できるようにし、LINE送信の重複や結果不明時の再送事故を防ぎやすくしました。同時に、ログインセッション、テナント分離、患者向けLIFFの初期表示、予約の空き時間判定、コード配置、データベース移行の土台を整理しました。

### 利用者ごとの変更とメリット

| 利用する人 | v0.33.0で変わること | メリット |
| --- | --- | --- |
| 患者 | LIFFの画面枠と「読み込み中」の案内をJavaScriptより先に表示 | 初回起動時の白い画面を減らし、処理中であることが分かる |
| 薬局職員 | Growth Dashboardに、JSTの月ごとの送受信数、手動・自動、push・reply、通知結果を件数だけで表示 | メッセージ本文や患者IDを開かず、担当LINEアカウントの運用量を確認できる |
| 予約担当者 | Google Calendarの終日予定も予約済みとして扱い、空き枠を表示できない理由を画面に表示 | 終日予定との二重予約を防ぎ、候補日時が出ない原因を確認しやすくなる |
| owner/admin | パスワード変更・スタッフ無効化時の既存セッション失効、セッションの世代管理、期限付きサポート権限を強化 | 無効になったセッションや、別セッションへの権限使い回しを防ぎやすくなる |
| 運用担当 | LINE送信を担当アカウント別の送信台帳と安定した再試行キーで追跡 | 通信切断後の安易な再送や、古い処理・重複した定期処理による二重送信を減らせる |
| 開発者 | データベース移行の基準、テナント／LINEアカウントの境界、薬局専用APIの配置、MCP APIの呼び出し処理を整理 | 新規環境を再現しやすくし、薬局固有処理や外部APIエラーを安全に管理しやすくなる |

### メッセージ配信と運用統計

- `messages_log.line_account_id`とアカウント・日時の索引を使い、送信・受信、手動・自動、push・reply、テスト送信、旧形式で担当不明の記録を分けて集計
- 統計APIは、認証済みスタッフが担当するLINEアカウントだけを対象とし、最大32日、`from < to`、ISO形式の日時を検証
- テスト送信、通常の一斉送信、シナリオ、予約・リマインド、薬局通知を既存の送信台帳へ接続
- LINE側で送信に成功した後のDB記録失敗、長時間止まった処理、結果不明の送信は、再送前に照合が必要な状態として保存
- 同じ業務操作には同じ再試行キーを使い、古い処理や重複した定期処理から同じメッセージが送られることを抑止

### ログイン・権限・テナント分離

- 自動応答、自動処理、リマインド、シナリオ、テンプレート、フォーム、予約、webhook、LINE Harness Proxyの検索・更新を、サーバーが確定したテナントと`line_account_id`へ限定
- スタッフ無効化や認証情報変更時に既存のログインセッションを失効し、Platform adminの一時権限を発行元セッションへ結び付け
- 旧形式のセッション未紐付け権限を段階的に無効化し、更新後のセッションを同じ世代として追跡
- BANの稼働状況集計で担当アカウントの条件が欠ける問題と、指定アカウント用のLINEクライアントがない場合に別アカウントへ切り替わる問題を修正
- 患者ID、LINE friend ID、メッセージ本文、秘密情報、接続先の応答本文を、新しい統計・監査・運用ログへ出さない契約を維持

### 予約、Google Calendar、MCP

- Google Calendarの終日予定を空き時間から除外し、`end.date`を予定に含まないGoogle Calendarの仕様、JST変換、複数ページ取得、重なった時間帯の結合に対応
- Google Calendarの取得に失敗した場合は、空いているとみなさず予約受付を安全側に停止
- 患者向けLIFFとサロン予約画面で、候補日時を表示できない理由を案内
- シナリオのタグ選択で「タグが0件」と「取得失敗」を区別し、再確認方法を表示
- MCPサーバーのAPI呼び出しを共通化し、パスのすり抜けを拒否。接続先が返したエラー本文は利用者へ表示せず、APIの未登録とデータの未存在を区別

### 動作速度とコード整理

- 1秒の読み込み遅延を入れた検証で、LIFFの最初の表示を中央値約1,045msから約10msへ短縮。これは白い画面を減らす改善であり、LIFF全体の読み込み完了時間やバンドル全体の高速化を示すものではありません
- 20万行の模擬データで、担当アカウント・日時別の集計に索引が使われ、集計結果が変わらないことを確認
- 共通Web APIクライアントに含まれていた薬局専用のGrowth/Rich Menu API 421行を、既存の`custom/pharmacy`配下へ移動
- LINEの再試行キー判定を既存の共通サービスへ集約し、重複実装を削除
- update engineのWorker URL正規化から、`/`が非常に多い入力で処理時間が急増する正規表現を削除
- 11個のワークスペース内パッケージ間に、内部依存の循環がないことを確認

### データベース移行に関する重要事項

- 正式公開前の移行履歴を`001_v033_baseline.sql`へまとめ、v0.33.0固有の変更を`002`〜`008`へ整理。新規環境はこの8ファイルから構築
- 古い移行履歴を記録した既存DBへ、そのまま上書き適用しない。update engineは履歴の世代が異なる場合に`wrong migration epoch`で停止
- 開発用DBを更新する場合も、バックアップ、初期化、再作成、読み戻しを別途承認してから実施
- 本番DBの初期化、移行適用、既存データの補完は未実施

### 変わらない安全条件

- 担当者による1対1の手動送信は`X-Line-Harness-Source: manual`を付け、自動通知には付けない
- 自動通知は患者情報を含まない承認済み文面だけを使用
- AI/OCR、薬剤の自動判断、新しい患者・処方せんドメインモデルは追加していない
- ソースコードのタグ、販売者向けリリース、開発環境への配備、本番配備、薬局アカウントへの適用を別々の実績として扱う
- 本番環境への配備、DB操作、実患者データ操作、実LINE送信は、別途人による承認なしに実行しない

### 確認状況

| 確認項目 | 結果 |
| --- | --- |
| Worker | 236 files / 2,536 tests、typecheck PASS |
| database | 82 files / 394 tests、typecheck PASS |
| update engine | 22 files / 219 tests PASS |
| Web | 52 files / 233 tests、typecheck、68-route static build PASS |
| LIFF | 20 files / 128 tests、typecheck、build、Chromium 13 tests PASS |
| 配備・運用スクリプト | 19 files / 225 tests PASS |
| 本番環境への配備・DB移行・LINE操作 | `NOT_RUN` |

ローカル環境と模擬データによる詳細な証拠、未実施の確認項目は`docs/pharmacy/evidence/v0.33.0-engineering-foundation.json`に記録しています。ソースコードを公開した事実だけで、本番運用の準備完了とは判断しません。

## Pharmacy v0.32.0 (2026-08-24)

> 公開状況: v0.32.0はローカル実装候補です。package version `0.32.0`とseller release `pharmacy-v0.32.0`は別物であり、seller release作成、deploy、薬局アカウントへの反映、本番データ操作はまだ行っていません。

### このバージョンで目指したこと

患者には「次に何をすればよいか」が分かるLINE画面を、薬局職員には「今日どこを確認すべきか」が分かる管理画面を提供します。同時に、患者情報の暗号化、保存期限、削除、バックアップからの復旧を、誤った対象や不明な結果のまま進めない仕組みにしました。

### 利用者ごとの変更とメリット

| 利用する人 | v0.32.0で変わること | メリット |
| --- | --- | --- |
| 患者 | LINE内の機能を「今すぐ行う」「送信後の確認・フォロー」「薬局情報・相談」の3つに整理。各画面に現在の状態、次の操作、入力途中で戻る場合の注意を表示 | 目的の手続きを見つけやすくなり、処方せん送信や問診の途中で迷いにくくなる |
| 緊急避妊薬を希望する患者 | 新しく作成する薬局アカウントでは緊急避妊薬機能を既定ONに変更。ただし、薬剤師、在庫、受付枠、同意などの準備が不足している場合は受付を開始しない | 準備が整った薬局は案内を始めやすく、未準備の薬局で患者を誤って受付へ進ませることを防げる |
| 薬局職員 | 管理画面を「ホーム」「日常業務」「患者・法令」「設定・安全」に整理。対応待ち、準備不足、権限不足、確認のみの状態を分けて表示 | 必要な業務を探す時間を減らし、対応すべき案件と設定作業を混同しにくくなる |
| 個別相談を担当する薬局職員 | Google Calendarの個別相談を登録・変更すると、同じ担当アカウントへ前日・1時間前のLINEリマインドも一括登録。取消時は未送信リマインドも取消 | 別アカウントの予定を誤操作しにくくなり、予定変更時のリマインド登録漏れを防げる |
| 薬局owner/admin | アカウントごとに利用機能、準備状況、患者画面やLINEへの反映状況を確認可能。既存アカウントで明示的にOFFにした機能は維持 | 新機能を段階的に有効化でき、既存の薬局運用を意図せず変更する事故を避けられる |
| Platform admin・CLI運用担当 | tenant staffの作成、role・担当LINEアカウント変更、password再発行、削除をCLIから実行可能。最後のownerや最後の担当者を失う変更はDBでも拒否 | 管理画面へ入れない障害時もstaffを復旧でき、同時操作で薬局の管理者・担当者が0人になる事故を防げる |
| Platform admin・運用担当 | 薬局全体を「全体状況」「初期設定」「運用」「セキュリティ・監査」「データ保護」など6領域で確認。通常画面には患者件数、内部ID、生のエラーを表示しない | 患者情報を広く閲覧せずに、準備不足・未検証・対応待ちの薬局を切り分けやすくなる |
| データ保護・復旧担当 | 暗号化移行、保存期限、legal hold、削除、復旧を、承認者・実行者・対象範囲・事前確認・再開条件つきで管理 | 対象間違い、二重実行、hold中の削除、結果不明な削除を止め、安全に再確認しやすくなる |

### 患者向けLINE画面

- 薬局名、画面名、戻る先、全機能一覧への導線を全画面で統一
- 処方せん、患者アンケート、緊急避妊薬、服薬後フォロー、継続支援に、現在の状態と「次にすること」を表示
- 本文の読みやすさ、色だけに頼らない状態表示、44px以上の操作領域、LINE内ブラウザのsafe-areaへ対応
- 処方せん画像やアンケート回答の入力途中データは、`localStorage`などへ永続保存せずメモリ内だけで保持
- 通信失敗や権限不足では内部エラーを表示せず、再試行または薬局への確認方法を案内
- 患者向け8 routeすべてをChromiumで描画し、keyboard focus、390px幅、200%文字拡大、横はみ出しなし、44px操作領域を確認

### 薬局職員・管理者向け画面

- ホームに、本日の対応、期限、未対応、送信停止、設定不足と、その次に確認する画面へのリンクを表示
- 機能がOFFでも対応中の案件がある場合は消さず、`確認のみ`として表示
- 一般staff、admin、ownerの閲覧・変更範囲を画面とAPIの両方で統一
- Platform adminの患者情報アクセスは、理由、ticket、再認証、期限つきsupport grant、監査記録が揃った場合だけ許可
- 一部の状態を取得できない場合は正常や未設定と表示せず、該当部分を`UNVERIFIED`として区別
- Platform admin CLIのstaff作成・role/担当変更・password再発行・削除はserver側tenant/account authorityを再確認。one-time passwordの応答が失われた場合は成功とも失敗とも決めつけず、0600の`UNKNOWN_OUTCOME` markerを残して自動再試行を止める
- 薬局の画像uploadは認証済みstaffの担当LINEアカウントへ固定し、R2 mutation前にaudit intentを保存。薬局tenantからの汎用DELETEは拒否

### Google Meet個別相談

- `POST /api/meet-consultations`は、認証済みstaffが割り当てられたtenant・LINEアカウントの相談だけを登録・変更
- 相談記録と前日・1時間前のリマインドを同じDB処理で保存し、どちらか一方だけが残る状態を防止
- `DELETE /api/meet-consultations/:externalEventId`で、相談と未送信リマインドを同じ担当範囲内で取消
- 自動LINE通知は相談名などの患者情報を含めない固定文面を使用

### データ保護と復旧

- 患者アンケートの暗号化移行を途中から再開でき、暗号化対象の不足、異なる鍵、改ざん、別tenant・別accountのデータ混入を拒否
- 問診のv1/v2 keyを別root secretとして扱い、明示的にv2をactiveにした後、1患者回答の2 fieldを1本のtenant/account scoped CASで同時に再暗号化。競合時は片方だけ更新せず停止
- 保存期限による削除は、tenant・LINEアカウント・承認済みoperation・legal holdを削除直前まで再確認
- 処方せん画像・受信画像は既存のR2 keyを上書きせず、削除結果が不明な場合は完了扱いにせず照合待ちとして記録
- 途中停止したretention処理は、保存済み件数とcursorから再開
- D1、R2、暗号化データ、通知台帳、webhookを同じ世代として署名し、外部送信機能を持たない隔離環境で復旧内容を照合
- 復旧後はDB schema、行数、R2所有権、暗号化参照件数、未処理通知を実データから再計算し、不一致を復旧成功として扱わない
- 署名済みmanifestに対応するD1・R2 artifact fileをno-sendメモリ環境へ読み込むadapterを追加。ローカルsynthetic fileで欠落object、改ざん、wrong keyを拒否し、v2だけの復旧read-backを確認

### 変わらない安全条件

- 緊急避妊薬の受付可否や販売可否を自動判断しない。最終判断は薬剤師が行う
- 既存薬局アカウントで明示的にOFFにした緊急避妊薬機能を自動でONへ変更しない
- Platform admin CLIのtenant/account設定変更機能と、初期リッチメニューv5固定を維持。v3/v1のrollback assetも削除しない
- rotation/rewrapはローカルsynthetic testのみ`PASS`。retention方針未決、削除結果不明、実cloud復旧未実施などは`READY`にせず、`UNVERIFIED`、`BLOCKED`、`NOT_RUN`を維持
- productionのsecret投入、暗号化移行、plaintext削除、retention削除、復旧、deploy、実LINE送信は別のHuman Gateなしに実行しない

### ローカル確認状況

| 確認項目 | 結果 |
| --- | --- |
| workspace test | 412 files / 3,314 tests PASS |
| Worker test | 225 files / 2,260 tests PASS |
| deploy・運用script test | 18 files / 222 tests PASS |
| migration contract | 90 migrations PASS |
| LIFF Chromium smoke | 12 tests PASS |
| review修正後のtypecheck・build | `NOT_RERUN` |
| exact-candidate Repository Verify | `NOT_RUN` |
| development deploy・account activation | `NOT_RUN` |
| production Human Gate | `NOT_RUN` |

additive migrationは`custom_055`から`custom_059`です。機械可読の詳細証拠は`docs/pharmacy/evidence/v0.32.0-development-assurance.json`に記録しています。

## Pharmacy v0.31.1 (2026-08-24)

> package version `0.31.1`とseller tag `pharmacy-v0.31.1`は別identityです。この項目はsource変更を記録し、production deploy、account activation、実アカウントのLINE mutationはそれぞれの実行証拠で確認します。

### リッチメニューの初期設定と並び替え

- 左上を「処方せん事前送信」へ統一し、管理画面の並び替え表示も実画像の「受付状況」「服薬後フォロー」「薬局へ相談」「薬局情報」と一致
- 機能設定から既存の並び替え位置へ直接移動し、画面内に「機能ON/OFF → 並び順保存 → 画像保存 → LINE登録 → 初期表示切替」の5手順を表示
- 初回だけ保存名へ「通常営業メニュー」を自動入力し、利用者向けの`version`・`catalog`表記を「保存済みメニュー」・「画像テンプレート」へ変更
- 「処方せん事前送信」と「受付状況」は同じ処方せん受付設定で同時にON/OFFされることを明示

### 権限制御

- 一般スタッフは保存状態・画像・公開中との差分を閲覧できますが、並び順、運用状態、保存済みメニュー、LINE登録・切替・復旧は変更不可
- owner/adminだけが変更できる境界を管理画面とWorker APIの両方で検証し、LINE readiness確認や外部mutationより前に403で拒否
- すべての薬局向けquery・mutationは既存どおり`line_account_id`、tenant、スタッフ割り当て、機能許可で限定

### release gate

- database migrationと新規dependencyはありません
- PR #83を`dev`へmergeし、exact `dev` head `742027f0e8cf294aaa529dec62fcb25d32018e3a`のrequired checkとdevelopment deployが成功
- PR #84を`main`へmergeし、exact `main` head `56d5aec5d42865afd13c4c1694dc1c554ad27545`のRepository Verifyが成功
- production deploy、account activation、実アカウントのLINE mutationはこのsource releaseに含めない

## Pharmacy v0.31.0 (2026-08-24)

> package version `0.31.0`とseller tag `pharmacy-v0.31.0`は別identityです。この項目はsource変更を記録し、production deploy、account activation、LINE mutationはそれぞれの実行証拠で確認します。

### ユーザーにとっての変更

v0.31.0はセキュリティ・プライバシー・信頼性の底上げに集中した版で、緊急避妊薬フォームの新フェーズを除き画面上の新機能はほぼありません。本版を適用した環境に反映されます。

| 対象 | v0.31.0で変わること | 変わらないこと |
|---|---|---|
| 患者 | 緊急避妊薬の事前情報フォームがv2になり、アレルギー・肝疾患・妊娠/授乳・月経状況などを追加で確認し、該当時は産婦人科等の代替導線を表示。同意文言も改定 | 既存の受付・チャット・処方箋送信の操作手順は変わりません |
| 薬局スタッフ | 緊急避妊薬の対面確認・薬剤師記入欄・販売記録（法定3年保存）が管理画面に追加。リッチメニュー変更後の再確認・復旧、LINEアカウント切替時の画面状態リークの解消も含む | 受付・チャット・患者対応の基本操作手順は変わりません |
| 運用担当者 | Webhook配信・通知送信・キャッシュ・外部連携の障害時挙動が全面的に堅牢化され、test・security scan・license確認・SBOM・build provenanceを1つのCIで確認可能に | production deploy、実患者データや本番LINEアカウントの変更は別のHuman Goで管理します |

### 緊急避妊薬 事前情報収集フォーム v2

Phase A（schema変更なし）:

- アレルギー・肝疾患・現在妊娠中・授乳中の4項目（A3/A4/A5/A'）を追加。送信は止めず、該当時は同画面に産婦人科・ワンストップ支援センター・他薬局一覧の代替導線を表示
- 服用期限（性交後72時間）を入力直後に残り時間つきで表示し、期限超過した選択肢を無効化
- 同意文言を改定（対面での申告再確認、最終判断は店頭、保存期間の明示、薬剤師の販売記録は法令により3年保存、3週間後の妊娠検査案内）し、`consent_version`未更新での作成・content hash不一致時は409で拒否
- 新規payloadフィールドはすべて暗号化領域に格納し、平文で保持するのは`pre_review_flagged`フラグ1個のみ。患者向けprojectionから`risk_flags`・`age_band`を除外

Phase B（対面確認・販売記録、`custom_051`追加）:

- `pharmacy_emergency_counter_confirmations`（薬局側のセクション単位対面確認、insert-onlyで更新不可）と`pharmacy_emergency_sale_records`（no_update/no_deleteトリガー付きの法定販売記録、`UNIQUE(line_account_id,intake_id)`）を追加
- 服薬指導前の追加確認（B1〜B4）、月経状況（C1/C2、複数選択＋「わからない」排他）、妊娠検査の要否をサーバー側算出（患者には非表示）
- 管理画面にA〜Dセクション表示・相違個別マーク・薬剤師記入欄（本人確認／妊娠検査／販売可否＋理由／面前服用／説明済み／受診勧奨／紹介／紙受領枚数）を追加。Aセクション未完了のまま`completed`遷移すると楽観ロック(CAS)で409
- 販売不可の記録は`cancelled`＋`outcome='refused'`として保存し、専用enumは追加しない
- 入力バリデーションを強化：`lastMenstruationDate`の日付形式検証、月経signalsの余剰キー拒否、未削除の受付が残っている間は保存期間(`retention_days`)の延長をブロック（`EMERGENCY_RETENTION_INCREASE_BLOCKED`、409）

### Myna起動URLの署名化とretention整備

- `/r/myna/:tenantAlias`の公開URLを廃止し、認証済みhandlerだけが発行する短命HMAC署名トークン（`/r/myna/:token`）へ置き換え。alias総当たりによるテナント側endpoint URLの列挙を遮断し、rate limit除外対象からも本pathを除外
- 緊急避妊薬の`retention_days`超過intakeを削除する新しいpurgeジョブを追加（account単位・leaf→root順・legal hold中はskip、1バッチ100件上限、6時間cronへ登録）。既存の処方箋purgeにも同じlegal hold除外を後付け
- 受信LINE画像のR2 keyを`pharmacy_incoming_image_objects`で追跡開始（forward-only、既存行は対象外）。挿入は`INSERT OR IGNORE`にしてdurable inboxの再試行でも安全に
- Webhook inbox内で24時間を超えて`pending`/`processing`のまま滞留するreceiptをdead-letter化する滞留検知を追加（本文は削除しない）
- retentionの残存課題を明文化：`retention_days`削除後もowner_friend_id・age_band・safe_contact_mode・監査ログは残るため`RETENTION_MATRIX.md`を「部分的に強制」へ更新。redactedなintakeの詳細取得は復号を試みず`{redacted: true}`を返すよう修正（従来は復号失敗で503になっていた）
- 3年境界purgeの削除順序（leaf→rootの約11 table、FK依存、JST/UTCカットオフ書式）を仕様化（実装は初回データが到達する2029年まで不要のため見送り）

### テナント分離とキャッシュ境界

- users-grouped集計とduplicate-statistics集計の共有サービスに認証済みtenant scopeを必須化し、単一キャッシュをtenant別キャッシュへ分離（別tenantのPHIが混入するリスクを解消）
- 両キャッシュに5分TTL・アクセス時パージ・最大8 tenantのLRU retentionを追加し、無制限増加を防止
- SQLite実データによるtenant A/B分離の統合テストを追加（アカウント間で共有される識別子を含むケースも網羅）

### Webhook配信の冪等性とfencing

- outgoing webhookの宛先選択をtenant単位に限定。受信webhookの処理では、サーバー側webhookレコードから解決したtenantを以降の自動化選択へ伝播し、tenant-onlyイベントは同tenantのaccount-mapped自動化だけを実行（accountなし・別tenant・薬局genericの自動化は実行しない）
- durable inbox（LINE/Stripe/受信webhook）の行所有権をUUIDベースのclaim tokenで単一行ロック化。成功/失敗の確定にはtenant/account/event key・処理状態・token一致・非dead-letter行の完全一致を要求し、所有権を失っていれば`skipped`を返す
- 処理中は1分ごとのheartbeatで5分leaseを同じtoken条件下で延長し、タイマーは終了処理前に必ず停止・完了を待つ。lease超過後は別workerが安全に再クレーム可能
- リトライ上限に達した行は、アクティブにリースされている間は退役させず、期限切れ後にのみtokenを失効
- 追加の汎用webhook配信metadata（`custom_053`）を新設し、tenant/account scopedな配信先UUID・イベント種別・結果・claim token・HTTP statusのみ記録（request bodyや生のsource event keyは保存しない）。設定済みoutgoing webhookとautomationの`send_webhook`を1つの配信境界へ統合し、HTTPS必須・redirect禁止・10秒deadline・upstream応答bodyの非取得を共通化
- 受信webhookの`Idempotency-Key`はサーバー側webhook IDで名前空間化し、別webhook間でのkey衝突を防止。8〜160文字のopaque-key契約に違反する値は400で拒否（未指定時は従来どおりbest-effort）
- 設定済みwebhookの再送はdelivery行の不変な作成時刻から本文とHMACを再生成し、同一`Idempotency-Key`で本文・署名が変化する不具合を解消

### LINE通知経路の堅牢化

- 共有push helperに`AbortSignal.timeout`ベースの10秒deadlineを追加し、Harnessプロキシ経由でabort signalをLINE upstreamまで伝播
- timeout・transport失敗・proxy 5xxを`LineHarnessUnknownOutcomeError`として区別し、upstream応答bodyを含めずに例外化。この場合は通知台帳を`attempted`のまま保持し、15分後の再クレームで同じstable retry keyを再利用
- LINE dispatch自体の失敗とD1側の`sent`確定失敗を分離：LINE送信は成功したがD1確定だけ失敗した場合は`failed`へ誤って上書きせず`attempted`のまま維持
- 処方箋ステータス・有効性チェックの通知呼び出し元は`in_progress`を未確定・再試行可能として扱うよう統一（他の送信元は既に対応済みだった）
- 既存の処方箋再送sweepを拡張し、`pharmacy_notification_events`台帳から現在ステータス通知を復旧できるようにした（isolate evictionでdomain監査が欠落したケースを救済）
- LINE受信画像のダウンロードに10秒abort signalと10MiBストリーミング上限を追加（`Content-Length`欠落時も有効）。上限超過はR2保存前にキャンセル

### 外部連携のエラー詳細漏洩対策

各種upstream連携の失敗ログ・エラーオブジェクトから、応答body・raw error・個人識別子を排除し、operation名とHTTP statusのみを構造化ロガーで記録するよう統一：

- LINE Harness Proxy（profile lookup、friend作成、post-send log、upstream fetch）
- Google Calendar・service-account token・OAuth token（失敗時はHTTP statusのみ保持、応答bodyは読まない）
- 共有予約Google Calendar同期を、固定タイトル「LINE Harness予約」＋開始/終了時刻＋疑似匿名event ID＋任意のGoogle Meet生成のみへデータ最小化。患者名・相談メニュー・患者備考・担当者名の送信を廃止（オンライン服薬指導機能ではなく個別のMeet予約であり、規制対象機能はv0.41.0以降まで凍結を維持）
- LINEトークンリフレッシュ（アカウント名・raw errorのログ出力を廃止）
- スタッフチャットのローディングアニメーションroute
- Meta・X・Google Ads・TikTokのconversion送信（失敗時は自社providerのclick IDのみ保存し、1プラットフォームの設定不備が他プラットフォームの実行を止めないよう修正）
- ad-platform設定のGET/POST/PUTを1つのfail-closed projectionへ統合し、`pixel_id`等のscalar値のみ返却。credentialの部分マスクや完全開示を排除
- 更新時に伏せ字(`********`)や省略されたcredentialを保存済みの値のまま保持し、明示された新credentialだけを置換（従来は伏せ字での上書きが保存済みcredentialを破壊していた）
- レガシーLIFF OAuthコールバックとIG cross-link連携（friend ID・IGSIDを含む生エラーの非露出）

### assurance baseline（CI・供給網・provenance）

- CIを単一の`Repository Verify`へ統合（重複していた`Worker CI`/`Web CI`を削除）し、全workspaceのtypecheck・test、migration contract、Worker/Web/LIFF buildをpath filterなしで全PRに適用。`main`/`dev`のrequired status checkを`verify` 1件・`strict=true`・admin enforcement・force-push/削除禁止へ統一
- 同じworkflowへLIFF Chromium smoke、CodeQL、new-commit secret scan、production dependency/license baseline、CycloneDX 1.6 SBOM、provenance用OIDC job（test/build jobには権限を付与しない）を追加し、synthetic artifactのattestationを`gh attestation verify`で検証
- redacted full-history secret scanの181候補（curl認証ヘッダー・APIキーのpattern一致）を値を保存せず分類し、文書内placeholder・test fixture・rich-menu識別子・環境変数名と判定。live credentialとGitHub secret scanning open alertは0件
- production dependency auditはhigh/critical脆弱性0件、license inventoryはunknown/unlicensed 0件。LGPL native packageは配布artifactに含まれず、LINE系51 packagesは公式LIFF用途に限定
- LIFF起動の成功経路smokeを追加（従来は`liffId`欠落によるエラー経路しか検証していなかった）。SDKをbrowser側でmockする専用E2E serverを追加し、production buildは実SDKのまま
- Mynaの署名tamper検証テストを決定的な形に修正（Base64URLの最終文字を書き換えるとHMAC対象外のpadding bitしか変わらず偽陰性になっていた）
- release-critical 3 workflowsの`actions/checkout`・`pnpm/action-setup`・`actions/setup-node`をreview済みNode 24リリースの固定SHAへ更新し、`actionlint` warningを0件に
- PR #79と#80を`dev`へmergeし、package versionを`0.31.0`へ統一。exact `dev` headのCI・development deploy・provenanceを確認

### 本番デプロイの人間ゲート

- productionへの自動デプロイ（`main` push起動）を廃止し、`workflow_dispatch`かつ入力した承認source SHAが`GITHUB_SHA`と完全一致した場合のみ、dependency installや外部mutationより前のgateを通過するよう変更
- canonical release manifestへsource SHA・package version・独立seller tag・environment・stage・D1 schema fingerprint・migration checksum・各artifact hash・deployment/rollback evidenceを記録。PHIは含めない
- production v0.30.2をread-onlyで再照合し、D1 migration 123/123とschema fingerprintを固定
- Platform Admin CLIへaccount-scoped・PHI-freeなLINE rich-menuのremote state GETだけを許可し、import・remote deleteは引き続き拒否
- development synthetic LINE accountでrich-menu candidate作成・image upload・set-default・fresh read-back・explicit rollback・rollback後read-backを人間立会いで完遂し、known-goodへ復帰（結果不明・未解決operation・blind retry・remote deleteはいずれも0件）

### release実行gate

- `dev`→`main`はrequired check成功後にmergeし、exact main source SHAを固定
- production deployはmain pushでは起動せず、Human Go後の手動workflowで承認source SHAを完全一致させる
- production workflowでruntime version、artifact digest、migration、Worker・LIFF・Admin health、customer configuration保持をread-back
- 上記がPASSしたexact main commitだけへ`pharmacy-v0.31.0` tagとGitHub Releaseを作成

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
