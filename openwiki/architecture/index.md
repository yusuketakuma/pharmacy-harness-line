# ファイル

- [フロントエンド(LIFF と管理画面)](frontends-liff-and-admin.md) - 患者向け LIFF(apps/liff)とスタッフ向け管理画面(apps/web)の構成、薬局用 custom ディレクトリ、API 呼出しの認証方式、機能ゲート、配備時のセキュリティヘッダをまとめる。
- [共有パッケージ](shared-packages.md) - packages/ 配下の db・shared・line-sdk・sdk・mcp-server・update-engine・create-line-harness・plugin-template それぞれの責務、アプリからの依存関係、薬局フォークでの扱い。
- [システム全体構成](system-overview.md) - 薬局向け LINE 運用基盤(LINE Harness フォーク)のモノレポ構成、Cloudflare 上の実行環境、generic 機能と pharmacy custom seam の関係を説明する入口ページ。
- [Worker のリクエスト処理と cron](worker-request-and-cron.md) - Worker の Hono アプリの middleware 順序、静的アセット配信と SPA フォールバック、エラー処理、scheduled ハンドラの 5 分/6 時間 cron ごとの処理と薬局モード時の制限を説明する。
