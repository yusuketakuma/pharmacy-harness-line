# F33 最終candidate限定追補

ID F33-LR-R1 / audit_db、P `044e817d2685edad303bc1fe0708200855c0e3a8`。既存thread再利用、fresh全体最終独立レビューではない。旧F33-limited-review.mdは旧candidateの記録として保持し、この追補と区別する。

| path | P SHA256 | 最終W SHA256 |
|---|---|---|
| `apps/worker/src/routes/crm/chats.ts` | `d7ce045008a81d24930f0011a87bc7407f5a6ec52d3dd36194b9a19efd5ce431` | `9d775e4279739b69effa7ba0cfcc0014841070523c3d19b95dcc1829ce86e984` |
| `apps/worker/src/routes/crm/conversations.ts` | `0b51ab4e7f080128ce9cf9c202b3e41e1f9a0c4085f8195c8b88be475f4fbc98` | `6bab5963db97a8c8d08251398cebba12e30a91944e3ce2375e83bf5355363212` |
| `apps/worker/src/services/unanswered-inbox.ts` | `8f5fb3c2c0784d906afc13de23c32743a8c4edf631ea26ad8f3b737a644c1430` | `a8ba7d4cb56b4dfd5e3bf4b2cbebe04a353881133cc3b6efee27cded35d9ea06` |
| `apps/worker/src/routes/crm/chat-time.test.ts` | `不存在（新規）` | `8cffb3a97d9c9de3bb4b7be30fe86e7ec58483bc2a2e338dc4e07b8d6eb55145` |

HEAD/P/全4W hashを独自照合成功。conversations/unansweredのWは旧candidateから不変。

## 修正判断

親の公開field意味の指摘に同意する。旧candidateで「metadata時刻優先を意図的変更として許容」とした判断は、既存latest-message-or-chat-fallback契約を十分重視していなかった。最終candidateはdedupedのchats枝に `NOT EXISTS(last_any friend)` を追加し、非test messageがあるfriendはmessage raw timestampを採用、messageなしのみchat時刻fallbackを採用する。page latest_atとresponse d.last_message_atが一致し、既存公開field意味も保持する。

messageあり+より新しいchat metadataはmessage時刻へ戻り、metadataがNULLでもmessage優先。messageなしの場合は従来chat MAXの瞬間比較版でraw値維持。全NULLはNULLのまま。同じaccountFilterを用いたlast_anyの存在チェックであり、tenant/staff predicateを除去していない。test-only messageはlast_any対象外でchat fallbackとなる。argmax/tie/msに関する前レビューの非変更部分の判断は維持。

新test期待c,b,aは、同instant c/bのfriend ID tie-break後に古いmessageのaを並べるもので妥当。aの新しいmetadataを公開lastMessageAtに採用しない契約の回帰となる。chat-only/NULL caseは以前の未被覆を一部補い、raw時刻/null/content nullを確認する。NULLをcursorで跨ぐ全件paginationは依然保証しない。

限定差分に阻害findingなし。旧candidateの性能結果をこのrevisionへ無条件再利用しない。NOT EXISTSによる追加lookup/query plan変化は親の最終再測定対象。

## 読取・実行・限界

F33-W.json最終、chats.ts:322–353、test metadata cursor/新NULL case、初期と最終patch比較を実施。Python hashlib/git show/git rev-parse、cat/sedのみ。source/Git変更・独自test・外部・spawnなし。この記録のみ書込。P/Whash/patchは照合したがisolated replay自体は親証拠。

最終Worker test/typecheck/native/perf/fullverifyは親再実施中。旧86PASS/9PASSを最終10case実行証拠と読み替えない。旧レビューの同instant bare-column選択、invalid timestamp/JS-SQL精度、全NULL cursor、全auth監査外という限界を継続。最終検証の結果と4hashを統合時に結び付けること。commit/patch作成なし。
