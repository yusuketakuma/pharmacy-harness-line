---
type: architecture
title: フロントエンド(LIFF と管理画面)
description: 患者向け LIFF(apps/liff)とスタッフ向け管理画面(apps/web)の構成、薬局用 custom ディレクトリ、API 呼出しの認証方式、機能ゲート、配備時のセキュリティヘッダをまとめる。
tags: [frontend, liff, admin, react, nextjs, pharmacy]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-7659e51dc8cdc4c90711042a
    resource: repo://apps/liff/public/_headers
  - id: openwiki-source-f263829ed98c7810e17613ab
    resource: repo://apps/liff/src/custom/pharmacy/menu/PharmacyFeatureGate.tsx
  - id: openwiki-source-538814476df1b90002614fd2
    resource: repo://apps/liff/src/custom/pharmacy/PharmacyShell.tsx
  - id: openwiki-source-c73634aedae3bf7ec8239ce1
    resource: repo://apps/liff/src/custom/pharmacy/request.ts
  - id: openwiki-source-92e8f5d7de50bee2dd79d4c2
    resource: repo://apps/web/public/_headers
  - id: openwiki-source-ac9b852a2fa621958d429bb8
    resource: repo://apps/web/src/lib/api.ts
  - id: openwiki-source-dc090505b5acefab70b544bb
    resource: repo://apps/worker/src/middleware/security-headers.ts
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# フロントエンド(LIFF と管理画面)

<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
このリポジトリには 2 つのフロントエンドがあります。どちらも Worker(`apps/worker`)の API を呼ぶだけで、権限判断は Worker 側で行います(→ [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md))。

| アプリ | 利用者 | 技術 | 認証 |
| --- | --- | --- | --- |
| `apps/liff` | 患者(LINE 内ブラウザ) | Vite + React + react-router | LIFF の ID トークンを `Authorization: Bearer` で送る |
| `apps/web` | 薬局スタッフ・platform admin | Next.js(静的出力 `out/`) + React | Cookie(`credentials: 'include'`)+ CSRF トークン |

## LIFF(患者向け)

### ルーティングと薬局ページの共通枠

`apps/liff/src/App.tsx` が汎用機能(予約・イベント・ウェビナー・アフィリエイト)と薬局機能のルートを同居させています。薬局ページは `// custom:pharmacy-...` のコメント付きで import され、`PharmacyAccessProvider` → `PharmacyShell` → `PharmacyFeatureGate` の順に包んで表示します。EC(緊急避妊)ページだけは lazy import です。

- `PharmacyAccessProvider` は 2 段階で「使える機能」を読み込みます。まず認証なしの `GET /api/liff/config?liffId=...` で `accountName` と `enabledFeatures` を取り、次に認証付きの `/api/liff/pharmacy/feature-access` で `existingFeatures`(既存利用者向けの機能)を取ります。後者が失敗しても前者は生かし、`existingError` を出して縮退表示します。
- 初回読込に成功した後の再試行(手動・自動・オンライン復帰)は、子コンポーネントのフォーム入力を消さないようバックグラウンドで行います。
<!-- openwiki: broken internal link [/openwiki/workflows/growth-loop-and-rich-menu.md] link "/openwiki/workflows/growth-loop-and-rich-menu.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- `PharmacyFeatureGate` の `canAccessPharmacyFeature` は「`enabledFeatures` に含まれる」または「`allowExisting` が真かつ `existingFeatures` に含まれる」ときだけ通します。機能名は `prescription_intake` / `patient_intake` / `electronic_prescription` / `continuity` / `medication_followup` / `emergency_contraception` / `manual_chat` / `pharmacy_info` の 8 種です。サーバー側の判定(→ [Growth Loop・リッチメニュー・ベータ参加](/openwiki/workflows/growth-loop-and-rich-menu.md))が正で、この画面側の判定は表示制御にすぎません。

### API 呼出し(`request.ts`)

`requestPharmacyLiff` は URL に必ず `liffId` クエリを付け、ID トークンを Bearer で送ります。`liffId` は「どの薬局(テナント)の LIFF か」を Worker に伝える選択子で、権限そのものではありません。`navigation.ts` の `pharmacyRoute` も画面遷移のたびに `liffId` を引き継ぎます。

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
`requestPharmacyJson` は HTTP ステータスを患者向けの日本語メッセージに変換し(401=再ログイン、403=権限なし、409=再読み込み、429=待機、503=機能停止など)、`status`・`body`・`X-Line-Harness-Error` ヘッダを持つ `Error` を投げます。`isUnsupportedPharmacyFeature` は「古い Worker が `401 Unauthorized` を返す」または「`404` かつ `route_not_found`」を未対応機能とみなします。Worker とフロントを同時に配備しなくてもよいようにする、後方互換のための判定です(→ [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md))。

## 管理画面(`apps/web`)

- ページは `apps/web/src/app/<機能>/` にあり、薬局用のものは `prescriptions`・`continuity`・`patient-intakes`・`emergency-contraception`・`pharmacy-growth`・`pharmacy-features`・`platform-admin` などです。画面の部品と API クライアントは `apps/web/src/custom/pharmacy/<ドメイン>/` に置かれます。
- `apps/web/src/lib/api.ts` の `fetchApi` は `credentials: 'include'` で Cookie を送り、CSRF トークンを `localStorage` に保持します。認証エラー時は保存済みのスタッフ情報を消してログイン画面へ戻します。platform admin 用は別ファイル `platform-admin-api.ts` です。
- 薬局 API は必ず `accountQuery`(`line_account_id=...`)で対象アカウントを指定します。ただしこれも選択子であり、Worker が「そのスタッフはそのアカウントを操作できるか」を必ず検査します。
- `createRequestGate`(`request-gate.ts`)は世代番号で、アカウント切替後に遅れて返ってきた古い応答を捨てるための小さな仕組みです。

## 配備とセキュリティヘッダ

<!-- openwiki: broken internal link [/openwiki/operations/release-and-deploy.md] link "/openwiki/operations/release-and-deploy.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
両アプリとも Cloudflare Pages に配備します。`apps/liff/public/_headers` と `apps/web/public/_headers` は、全パスに `X-Frame-Options: DENY`・`frame-ancestors 'none'`・`nosniff`・`strict-origin-when-cross-origin` を付けます。CI(`.github/workflows/deploy-cloudflare.yml`)はビルド後に `_headers` の存在と、バンドルに API のベース URL が埋め込まれていることを検査します(→ [リリースとデプロイ](/openwiki/operations/release-and-deploy.md))。Worker 自身の全レスポンスにも `security-headers` ミドルウェアが同じヘッダを(未設定の場合だけ)付けます(→ [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md))。

## テスト

<!-- openwiki: broken internal link [/openwiki/operations/testing-and-verification.md] link "/openwiki/operations/testing-and-verification.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
LIFF には UI ルールを固定するテスト(`v034-ux-gate.test.ts`・`v036-ui-rules.test.ts`)と、旧版との契約テスト(`v032-contract.test.ts`)があります。管理画面には `ui-safety.test.ts` があります(→ [テストと検証](/openwiki/operations/testing-and-verification.md))。
