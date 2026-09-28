# AUDIT-DB-20260922 完全受入記録

- 担当/thread: `/root/audit_db`。限定読取り専用、実装/再帰spawnなし。
- 基準・成果: `f62b90acd41154ab07c27f13b89a70ecb0eaa452`。親のPLANS/監査資料追加のみ観測。変更path/commit/patchは非該当。
- 状態: 限定ソース調査完了、C03/C04/X03全体はPARTIAL。最終独立レビューの代替ではない。
- 保持契約: 既存migration不変、forward-only、旧データ・公開契約保全、tenant/account整合、認証情報・実データ非アクセス。
- 適用資料: AGENTS、scripts/AGENTS、agent-defaults、添付要求、CONTRIBUTING互換更新規約、RETENTION_MATRIXのfail-closed契約。巨大wiki全文は未確認。

## F-DB-01: CONFIRMED_BUG / P2 / 確度高

`check-migrations.ts:108–129`の`line.indexOf('--')`は`INSERT INTO logs VALUES ('--'); DROP TABLE friends;`を`INSERT INTO logs VALUES ('`まで切断する。ブロックコメントを挟む`DROP/* note */TABLE friends;`も規則を回避。入力→前処理→全規則→成功返却まで静的確認。CI/release/deployゲートに影響。実データ破壊の発生を示す証拠ではない。親は原コードとCONTRIBUTING規約を照合しF01へ採択。

## C-DB-02: EVIDENCE_BASED_CONCERN / 確度高（現行障害未確定）

`packages/db/scripts/generate-bootstrap.mjs:40–56`と`test/bootstrap.test.ts:33–58`は同じ単純セミコロン改行splitterを使用。複数行CREATE TRIGGERのBEGIN内部を分断する。現行025/026は同一行BEGIN...ENDで回避。update-engineには別scannerがあり、解釈不一致/責務重複の候補。実行再現・採択は未実施。

## 調査coverage

- REVIEWED（静的）: migration checkerとtests、bootstrap generator/replay tests、migrations 016/019/022/024/025/026の制約/scope/互換意図。
- helper読取り: `utils.ts`, `scoring.ts`, `tags.ts`, `account-settings.ts`, `chats.ts`, `line-accounts.ts`。scoringのbatch/ledger IDによる二重加算抑止、設定upsert、chat一意挿入、資格情報mask確認。route認可/全consumerは未確認。
- PARTIAL: `users.ts`, `mileage.ts`（出力一部/巨大file）、全migration内容、recovery/deletion後段trigger/consumer。
- recovery/deletion: schema.sql 1836–1998のFK/状態/owner/account制約、custom_057全文とcustom_056冒頭testを読取り。実行なし。
- retention/restore全体: PARTIAL。policy blockerのfail-closed契約は確認。backup/restore復活防止の端から端の証明は未実施。

## 検証記録と制約

`git status --short`, `git rev-parse HEAD`, `rg --files`, 対象限定`rg -n`, `cat`, `sed -n`, `nl -ba`, `wc -l`でソース/契約/呼出し場所取得成功。長い出力の切断部分はレビューに算入しない。install/test/build/DB query/外部接続は未実施。限定調査結果をTEST PASSや全coverage完了にしない。

未解決: F01のRED/GREENは親担当。C-DB-02の再現・採択判断、未読migration/helper、Worker認可/retention/restore consumer。
統合: コード取り込み不要。親が原ソース照合と本記録保存を実施。
thread: 完了通知受領。環境にclose APIがなく未closeとして扱う。追加子threadは開かず、必要な追加限定調査は同じthreadを再利用する。
