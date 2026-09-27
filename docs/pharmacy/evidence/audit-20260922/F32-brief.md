# F32 FIX: 手動チャット送信の例外ログ

- 状態: INTEGRATED。owner: /root、dev の既存 checkout。
- P: da40c463db40423af8bbc32ce2ade603949bcffb。入力 SHA は F32-input.json。
- 書込範囲: chats.ts と chats-manual-message.test.ts。読取依存: 構造化 logger、既存送信テスト、Worker 指示。
- 仮説: JSON.parse(content) の例外や送信依存からの例外を生ログへ渡すため本文が漏れる。合成入力で実ルートの catch を再現する。
- 期待根拠: apps/worker/AGENTS.md の PHI・request body・上流本文のログ禁止、既存 log() 使用規定。
- 保持契約: HTTP 500 の固定エラー本文、認可・credential・冪等性・送信順序、成功応答と保存形式。公開 symbol/引数/依存/schema の変更なし。
- 意図的差分: 失敗ログを固定イベントへ変更し、例外本文を記録しない。
- 検証: 現行コードで回帰テスト RED、修正後に既存手動送信・近傍・logging privacy・型チェック。差分再現と限定独立レビュー。
- 到達条件: 不正リクエストJSON、flex/image JSON、依存例外に合成機密マーカーがあってもログ・応答に現れず、既存契約を維持。
