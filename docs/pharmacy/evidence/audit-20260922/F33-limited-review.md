# F33 限定レビュー

ID F33-LR / audit_db、既存thread再利用。fresh全体最終レビューではない。
P `044e817d2685edad303bc1fe0708200855c0e3a8`、HEAD/P/W全hash一致を独自照合。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/routes/crm/chats.ts` | `d7ce045008a81d24930f0011a87bc7407f5a6ec52d3dd36194b9a19efd5ce431` | `fc4d7c3fed016578527e58262ca081e1d3655f2f4a1b3ca7cf1948135247a257` |
| `apps/worker/src/routes/crm/conversations.ts` | `0b51ab4e7f080128ce9cf9c202b3e41e1f9a0c4085f8195c8b88be475f4fbc98` | `6bab5963db97a8c8d08251398cebba12e30a91944e3ce2375e83bf5355363212` |
| `apps/worker/src/services/unanswered-inbox.ts` | `8f5fb3c2c0784d906afc13de23c32743a8c4edf631ea26ad8f3b737a644c1430` | `a8ba7d4cb56b4dfd5e3bf4b2cbebe04a353881133cc3b6efee27cded35d9ea06` |
| `apps/worker/src/routes/crm/chat-time.test.ts` | `不存在（新規）` | `1bcb64021c71c7f90d08bf59723f8a7e5634b396ec139c679d140ed536e76dcc` |

## 判定と契約

限定差分に確定した阻害bugなし。機能判断の確度は静的レビューとして高い。ただし性能/native engine/fullverifyは親の進行中であり、修復完了の総合判定ではない。

- conversations detailはbeforeとORDER BYがjuliandayへ揃い、reverse後の昇順とraw createdAtを維持。strict timestamp-only beforeは同instant全件を次pageへ含めない従来契約であり、ID cursor追加を暗黙に行っていない。明示ID順により同instantの表示順は安定する。msを秒へ丸めない。
- chats historyとlatest chat選択もjulianday+id。一覧last_any/dedupedは単一MAX(julianday)とbare raw timestampを使い、最大instantを持つ行のraw値を保持。page cursor/ORDER BYは同じlatest_atに統一しfriend ID tie-break保持。response lastMessageAtもd.last_message_atとなり、metadataがpreviewより新しい場合のcursor不一致を解消する。本文previewは最新messageを維持し、metadata時刻と本文時刻が異なる可能性は意図した契約。
- any_aggは単一MAXによるargmaxでcontent/direction/typeを同じ最大時刻の候補から得る。複数MAX化して選択根拠を曖昧にする変更ではない。ページ確定後のfriendだけcontentを読む構造も維持。
- conversations main/countのmanual vs incoming比較を同じnumeric instantへ変更。latest incoming preview windowもinstant順。時間経過計算とraw返却は継続。
- inboxはkindごとの単一MAXでraw argmaxを選び、外側MAX CASEは各kind最大1行のpivotとして使う。複数formatを再び文字列で比較して最新を選び直す構造ではない。recent manual cutoff、incoming/outgoing sort、JS最終順/oldest判定もinstant化。auto evidence消費/keyword条件は変更なし。
- tenant/account/staff/active/following/resolved/postback/test/source条件、bind順、limit/offsetは差分で保持。schema/writer変更なし。既存保存文字列を改変せず旧dataを読む修復。

## tie/NULL/精度の限界

同instantの複数rowがある単一MAXのbare columnsは任意tie選択という既存SQLite性質を残す。特にlatest_chat(status)集約は任意tie、chatsのORDER BYはid DESCなので、同instant重複chatでstatus選択が一致する保証はない。元からtie保証がなく今回専用回帰もないため新規阻害として断定しない。raw timezone表記が異なっても同instantならcursor数値比較は一致する。

nullable chats.last_message_atはMAXがNULLを無視し、全NULL群はNULLのまま後方となる。既存timestamp cursorでは全NULLを跨ぐ完全ページング保証がなく、今回も追加されない。NULL専用testは今回9caseにない。juliandayがNULLとなる不正文字列は従来text最大と違う扱いになり得るため、不正timestamp全般の互換保証はしない。JST/Zの有効ISO/msが主契約。JS Date.parseとSQLiteはmicrosecond以上/非ISOの一致を保証しない。

## テスト・証拠・未実施

新chat-time.test.ts全文をpatchと現ソースで確認。実SQLite bootstrap+実Hono readers/helperを使い、JST→UTC/逆/同一format/日付跨ぎ100ms、detail2page、list preview、answered除外、metadata新しい場合の複合cursor、混在argmaxとwait/oldest、equal instant strict before/test除外、auto evidence1回消費を9caseで検証する。aggregate queryを単に文字列assertするテストではない。mock認証contextであり全auth実証ではない。同instant argmaxのcontentはa/bどちらも許すので任意tieを新しい必須動作と混同しない。

親ログnear-initialは6files86PASS、final-testは9PASSを読取り。RED6FAIL3PASSは依頼報告であり本担当はred本文を未読。既読consumer調査を再利用し、今回の全patch、brief/input/W、関連上記ログ、最終test該当部分を読む。独自test/nativeD1/性能測定/fullverify/buildなし。isolated replay PASSはW上の親証拠。読取りコマンドcat/sed、Python hashlib/git show/git rev-parseのみ。記録以外source/Git書込・外部送信・spawnなし。

## 性能・統合注意

julianday ORDER BYはtext index順序を失う可能性、inbox kind GROUP BYは追加集約、一部sort追加がある。slim集約/内容後段限定は維持するが性能無劣化と推測しない。briefの50/500/5000件・10friend・9回中央値、事前W<=max(2P,P+15ms)、QUERY PLANとnative engineの親結果を統合条件とする。row scan数が取得不能なら未測定とする。NULL/tie等の上記限界を全互換PASSへ拡張しない。commit/patch作成非該当、全体fresh最終監査と独立の限定レビュー。
