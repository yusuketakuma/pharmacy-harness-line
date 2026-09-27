# 混在日時 consumer 限定調査

ID CT-LR / audit_db（既存thread）。P `044e817d2685edad303bc1fe0708200855c0e3a8`、HEAD一致。product変更なし。fresh最終レビューではない。

| path | 読取時 SHA256 |
|---|---|
| `apps/worker/src/routes/crm/chats.ts` | `d7ce045008a81d24930f0011a87bc7407f5a6ec52d3dd36194b9a19efd5ce431` |
| `apps/worker/src/routes/crm/conversations.ts` | `0b51ab4e7f080128ce9cf9c202b3e41e1f9a0c4085f8195c8b88be475f4fbc98` |
| `apps/worker/src/services/unanswered-inbox.ts` | `8f5fb3c2c0784d906afc13de23c32743a8c4edf631ea26ad8f3b737a644c1430` |
| `apps/worker/src/routes/crm/chats-list.test.ts` | `7124fbc03124378a544a6d2e8da90c1c4bf91bfcafe10810d430c6ff37442d8c` |
| `apps/worker/src/routes/crm/conversations-tenant-scope.test.ts` | `44081c297156191273a19b80f1377e80fba27c7f46d174c90cc0344c4dab5463` |
| `apps/worker/src/services/unanswered-inbox.test.ts` | `d65f92d98c56399f573b55a0044e6806dcfccc21269bdb92f5b5c46b7a9b6491` |

## 結論・具体的影響

親のdetail逆順/ページ欠落再現以外にも、指定consumerの文字列MAX/比較に同型の不具合がある。下記はソース上で結果を導けるconfirmed logic defect（確度高、重大度P2相当の表示・要対応判定誤り）。実環境発生件数や薬局本番到達は未確認、独自runtime再現はしていない。

1. conversations.ts:63–116/132–157 と unanswered-inbox.ts:95–131: incoming `2026-09-22T09:00:00.000+09:00` の後にmanual outgoing `2026-09-22T00:01:00.000Z` が成立しても、文字列上はmanual < incomingとなる。chat statusがunread/in_progressであれば、返信済みfriendが要対応候補として残る。conversationsのlist/count両方が同条件なので総数も過大。inbox recent incomings:149–162も同じ比較で返信前incomingを残し、keyword/evidenceによる除外がなければ最終inboxに残る。
2. chats.ts:323–365: last_anyおよびpreview any_aggのMAX(created_at)が古いJST incomingを新しいUTC outgoingより大と評価し、previewの本文/方向/種別が古い行になる。dedupedがchats.last_message_atとのMAXで一覧順だけ補える場合も、preview側MAXは誤ったまま。resolveOrCreateChat:110の初期last_message_atも誤った最大を保存し得る。
3. chats.ts:497–504: detailのORDER BY created_at DESC LIMIT1000→reverseで同じ2件が逆順。件数が上限に達すれば本来残すべき新しいUTC行を落とす可能性。conversations detail:256–286はbeforeだけjulianday、ORDER BYはtextという不一致。親の実Hono+SQLite証拠はこの2件をlimit1で読むと古いincoming→次page空、limit2で逆順を示す。

条件付きconcern: incoming側自体やmanual側内部に複数formatが混在する場合、各MAX/ROW_NUMBERの最新選択も誤る。unanswered-inbox.ts:357のlocaleCompareは最終行順も文字列であり、mixed incomingでは誤順。auto-reply候補SQL:178–192もmanual cutoffをtext比較する。consumeAutoReplyEvidence自体はDate.getTimeでepoch比較するため、その部分だけはoffset混在を正しく扱うが、前段の誤除外/順序を回復できない。incoming writerに混在があるという実証は今回していない。

## 修復時の保持契約

- writerだけ統一しても既存UTC/JST行の誤読は残る。既存データ削除・一括破壊的変換を前提にせず、readerがinstantを比較する。raw createdAtの公開文字列表現は別契約として保持可能。
- MAX値だけ数値化して元content/directionと切り離さない。argmaxに対応した同一行のraw timestamp/contentを返す。main/count、比較/ORDER BY/cursorを同一時間軸へ揃える。
- subsecondを保つ。strftime秒丸めだけの修復は同秒別millisecondを落とす。既存beforeはstrict < timestamp、同一instantの複数IDを全件ページングする保証は元からないため、別契約拡張として区別。chats複合cursorのfriend ID tie-break、beforeAtのZ/+09双方、NULLの扱いを維持。
- chatsのpage順はd.last_message_at、公開lastMessageAtはpreview時刻を優先する既存差がある。正規化だけでこのcursor値不一致まで自動的に直ったとしない。
- tenant/account/staff scope、following/active、resolved除外、postback除外、manualのみ返信扱い、auto reply evidenceの1対1消費と5秒窓、test配信除外（chats）/source推論（conversations）、limit/offset、raw response fieldを維持。

## 性能リスクと有限の検証案

日時列を関数で包むORDER BY/WHERE/MAXは既存text indexの順序/範囲seekを使えず、一時sortや追加scanが増え得る。chatsは全体のslim集約→page確定後だけcontent集約という既存設計を維持し、全friendのcontent window materializationを無条件に増やさない。候補数ぶんbindを増やすとD1上限再発の危険がある。expression index追加を検討する場合はadditive migration/旧version互換が必要であり、今回勝手に必須とはしない。

有限チェック: (1) 実SQLiteで上記2件のdetail/limit1+before/一覧preview/要対応list+count/inboxを通す。(2) JSTのみ/UTCのみ/混在、同秒別ms、同instant、日付跨ぎを小さなparameterized fixtureにする。(3) 他tenant/staff未割当、resolved/postback/test、auto evidence1対1の既存回帰を再利用。(4) chatsのbeforeAt+beforeId page2とchats fallback timestampがmessageと異なるcaseを確認。(5) 代表50/500/5000 messagesと複数friendに限定し旧新EXPLAIN QUERY PLAN/中央値/rows scannedを比較、実D1相当の一回のcompiled query確認。全repoの無限再監査は不要。

## 読取・実行記録・限界

実施: git rev-parse、指定3sourceに限定したrg datetime/MAX/ORDER BY探索、sedでconversations:35–160/250–310、chats:317–392/488–507、unanswered:55–78/85–198/300–367を本文確認。chatsのresolveOrCreate等は検索結果のSQL確認に留まる。関連testはchats-listのfakeDb/冒頭case、conversations-tenant-scope冒頭（後半にSQLitefixtureあり、全case未読）、unansweredのstubDB入口とtest名/日時fixture探索のみ。全test coverageを確認済みとは扱わない。初回出力truncate箇所は必要な本文に絞り再読。

親conversation-time-investigation.mtsの合成fixtureと実Hono/SQLite構造、red.logのexpected/actualを読取。親再現のpass:falseを独自実行結果と混同しない。writer root causeは親調査事項で、今回writer全文は再読していない。hashはPythonで記録。独自test/SQL実行/性能測定/build/外部通信/実データ/secret/spawnなし。source/Git/commit/patch変更なし、この記録のみ作成。上記性能数値は未測定であり、最終修復レビューと必要検証は別途。
