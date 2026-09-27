# F32 限定 read-only review

ID F32-LR / audit_db、既存thread再利用。fresh最終全体レビューではない。
P `da40c463db40423af8bbc32ce2ade603949bcffb`。WはF32-W.json固定2paths、P/WとHEAD一致を独自hash照合済み。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/routes/crm/chats.ts` | `c6c13861545c8271c3215a2db05fde9dfbb7ec63836ab5f3912e1e43908989a3` | `d7ce045008a81d24930f0011a87bc7407f5a6ec52d3dd36194b9a19efd5ce431` |
| `apps/worker/src/routes/crm/chats-manual-message.test.ts` | `ceeb2c00521dd26de96d6d9cdd9985aff1d1350316f1424a63d0a7c4175dd71c` | `0d846e72309d5d1c6f7405de69fd50e8ed84fb34c4852283dc526d76a4a1ec82` |

## 結論・保持契約

限定差分に阻害findingなし（静的確認の確度高）。手動send routeのcatchは例外objectを受け取らず、固定event `chat_manual_send_failed`、空fields、error levelで既存log()を呼ぶ。log.ts全文により実出力はts/level/eventだけになることを確認。logger自体のallowlistにerrがあるが、今回空fieldsのため例外本文は渡らない。

routeのtry全体は変更なし。tenant/manual marker/UUID idempotency/resolveAuthorizedChat、body取得、credential、text/flex/image構築、tracked delivery、409 reconciliation/in_flight、updateChat、成功応答の順序を維持。catch境界も同じで、request JSON・flex/image JSON・依存throw・送信後updateChat throwを捕捉し従来固定500 `{success:false,error:'Internal server error'}` を返す。エラー時に送信や保存をrollbackする新保証はない。送信済後の保存失敗が500となる既存挙動もそのまま。

公開API/schema/import dependency変更なし。HTTP非例外の早期returnを変えず、認可弱化や自動再送を追加しない。生エラー詳細をこのログから失うのは意図したprivacy契約変更で、既存Worker AGENTSのbody/上流例外ログ禁止と整合する。

## テスト検出力

追加4caseは実Hono route/実loggerで合成PHI_MARKを不正request JSON、flex/image content、delivery rejectionに入れる。固定500本文、console.error中markerなし、error呼出ちょうど1回、JSONログがts/level/eventのみであることをassert。単なるconsole文字列の部分一致だけではなく余分fieldも拒否する。updateChat未呼出、parse失敗はdelivery未呼出、provider push未呼出を確認。spyはfinallyでrestoreされる。

親F32-red-final.logで旧Pに4FAIL/既存10PASS、F32-near.logで4files18PASSを読取確認。実配送/credential/DB/authorization helperはmockであり全認可やD1保存を実証しない。console.warn/logへ出す別依存内部の漏えい、credential失敗・updateChat失敗の専用privacy回帰、実provider例外はこの4caseで網羅しない。ただし変更catchへの経路は同一。旧10testを変更せず追加のみであることをpatchで確認。

## 読取範囲・検証・制約

読取: F32-W/input/brief/patch、red-final冒頭・near全文・typecheck全文、chats.ts send route全体(644–731)と前後loading/隣接route、chats-manual-message.test.ts setup/mock/追加4case(1–180)、既存case名検索、log.ts全文。既読root/packages/Worker指示を適用。残りchat全route/全認証middleware/配送service内部は今回再監査していない。隣接routeに既存生例外logが見えることを全chatprivacy解決と取り違えない。

実施: cat/sed/rg、Python hashlibとgit show P:path/git rev-parse HEADによる2path照合成功。ソース/Git変更なし。記録のみ書込。独自test/typecheck/build/runtime/外部通信/実データ/spawnなし。F32-typecheck.logは `$ tsc --noEmit` のみで明示exit codeがないため、このログ単独でexit0を証明しない。isolated replay PASSはW記録上の親証拠で独自再実行なし。

統合注意: 固定2hashに対応した親の最終終了状態を記録すること。全Worker/compiled artifact/本番確認を本レビューから推測しない。既存例外の他ログsinkへの伝播は別範囲。変更・commit・patch作成は非該当。未解決の修復阻害依存なし、親検証証拠の不足は上記の通り。
