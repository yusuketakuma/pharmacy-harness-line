---
type: architecture
title: システム全体構成
description: 薬局向け LINE 運用基盤(LINE Harness フォーク)のモノレポ構成、Cloudflare 上の実行環境、generic 機能と pharmacy custom seam の関係を説明する入口ページ。
tags: [architecture, cloudflare, monorepo, worker, pharmacy]
verified:
  - by: openwiki/0.6.1
    at: 2026-09-29T04:00:15.496Z
sources:
  - id: openwiki-source-9a19f47c57e4460a65da6271
    resource: repo://apps/worker/src/custom/pharmacy/growth-loop/generic-feature-guard.ts
  - id: openwiki-source-36b9b14daad5e37bc5cb3676
    resource: repo://apps/worker/src/index.ts
  - id: openwiki-source-b85a94476aece4aac7751a17
    resource: repo://apps/worker/src/routes/README.md
  - id: openwiki-source-f581551daa93bc9a952f4e68
    resource: repo://apps/worker/wrangler.toml
  - id: openwiki-source-40275cb92c3610938f16ade3
    resource: repo://pnpm-workspace.yaml
generated: { by: "claude-code", at: "2026-09-29T04:00:15.496Z" }
---

# システム全体構成

このリポジトリは、OSS の LINE Harness(LINE 公式アカウント向け CRM)を薬局向けにフォークしたものです。患者は LINE と LIFF から処方箋送付・問診・服薬フォローなどを使い、薬局スタッフは管理画面と LINE の 1 対 1 チャットで対応します。

## 構成要素

```
LINE Platform ──webhook──▶ Worker (Hono) ◀── 管理画面 (Pages, apps/web)
      ▲                      │  │  ▲
      └── push/broadcast ────┘  │  └─ LIFF (Pages, apps/liff)
                                ├─ D1 (DB)
                                └─ R2 (IMAGES: 画像)
```

| 場所 | 役割 |
| --- | --- |
| `apps/worker` | Cloudflare Worker(Hono)。全 API、LINE webhook、cron、静的 client 配信 |
| `apps/web` | スタッフ向け管理画面(Cloudflare Pages) |
| `apps/liff` | 患者向け LIFF アプリ(Cloudflare Pages) |
<!-- openwiki: broken internal link [/openwiki/architecture/shared-packages.md] link "/openwiki/architecture/shared-packages.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| `packages/*` | 共有コード(→ [共有パッケージ](/openwiki/architecture/shared-packages.md)) |
<!-- openwiki: broken internal link [/openwiki/operations/tenant-provisioning.md] link "/openwiki/operations/tenant-provisioning.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
| `scripts/custom/pharmacy` | テナント作成などの運用スクリプト(→ [テナント作成と運用スクリプト](/openwiki/operations/tenant-provisioning.md)) |
| `docs/pharmacy` | 契約・運用・監査の正本文書 |

ワークスペースは `pnpm-workspace.yaml` の `apps/*` と `packages/*` です。

## 実行環境

`apps/worker/wrangler.toml` は次の束縛を定義します。

- `DB`: D1 データベース。
- `IMAGES`: R2 バケット(画像保存)。
- `ASSETS`: `dist/client` の静的アセット。`run_worker_first = true` なので、まず Worker が全リクエストを受けます。
<!-- openwiki: broken internal link [/openwiki/architecture/worker-request-and-cron.md] link "/openwiki/architecture/worker-request-and-cron.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- cron: `*/5 * * * *`(5 分ごと)と `0 */6 * * *`(6 時間ごと)。処理内容は [Worker のリクエスト処理と cron](/openwiki/architecture/worker-request-and-cron.md) を参照してください。
- `WORKER_PUBLIC_URL`・`ADMIN_PUBLIC_URL`・`LIFF_PUBLIC_URL` の各変数。開発用の設定がトップレベル、本番は `[env.production]` にあり、`account_id`・`database_id` などはプレースホルダです。

## generic 機能と pharmacy custom

Worker の HTTP ルートは 2 つの層に分かれます。

1. **generic 層**(`apps/worker/src/routes/<domain>/`): フォーク元由来の CRM 機能です。`admin/`・`crm/`・`messaging/`・`marketing/`・`liff/`・`booking/`・`integrations/` にドメイン別に置かれます。
2. **pharmacy 層**(`apps/worker/src/custom/pharmacy/<domain>/`): 処方箋、問診、服薬フォロー、継続、EC、Growth Loop、リッチメニュー、データ保護などの薬局固有機能です。管理者向け API は `/api/custom/pharmacy/*` に載ります。

`routes/README.md` の規則は「薬局機能は `custom/pharmacy` に置き、generic ルートは薬局モードでは middleware により fail-closed にする」です。`index.ts` は `PHARMACY_DISABLED_GENERIC_API_PREFIXES` の各プレフィックスに `pharmacyGenericFeatureGuard` を掛け、薬局アカウントから高リスクな generic CRM API(自動送信系など)を使えないようにします。手動チャットの書込みには `pharmacyManualChatMutationGuard` が別に掛かります。

<!-- openwiki: broken internal link [/openwiki/concepts/pharmacy-custom-boundary.md] link "/openwiki/concepts/pharmacy-custom-boundary.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/concepts/tenant-scope-and-auth.md] link "/openwiki/concepts/tenant-scope-and-auth.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
この分離の理由と、追加のみで更新するルールは [薬局 custom 境界と非破壊更新ルール](/openwiki/concepts/pharmacy-custom-boundary.md) にあります。認証とテナントの扱いは [テナントスコープと認証・認可](/openwiki/concepts/tenant-scope-and-auth.md) です。

## 主な処理の流れ

<!-- openwiki: broken internal link [/openwiki/workflows/line-webhook-and-outbound-delivery.md] link "/openwiki/workflows/line-webhook-and-outbound-delivery.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 患者が LINE でメッセージや友だち追加をする → webhook → 薬局モードの処理 → 返信・通知(→ [LINE webhook と送信配信](/openwiki/workflows/line-webhook-and-outbound-delivery.md))。
<!-- openwiki: broken internal link [/openwiki/architecture/frontends-liff-and-admin.md] link "/openwiki/architecture/frontends-liff-and-admin.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-patient-journeys.md] link "/openwiki/workflows/pharmacy-patient-journeys.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- 患者が LIFF を開く → `liffId` でテナントを特定 → 機能ゲート → 各ドメインの API(→ [フロントエンド](/openwiki/architecture/frontends-liff-and-admin.md)、[薬局の患者導線](/openwiki/workflows/pharmacy-patient-journeys.md))。
- スタッフが管理画面から操作 → Cookie 認証と `line_account_id` の割当検査 → API。
<!-- openwiki: broken internal link [/openwiki/workflows/pharmacy-notifications.md] link "/openwiki/workflows/pharmacy-notifications.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
- cron が期限切れ・リマインド・通知キューを処理(→ [薬局の自動通知](/openwiki/workflows/pharmacy-notifications.md))。
