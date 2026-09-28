# F35 限定 read-only review

ID F35-LR / audit_db（既存thread）。P `abda3847979e19b906ebe3f81c61cfac03cf901c`、HEAD一致。fresh全体最終独立レビューではない。

| path | P SHA256 | 読取時固定W SHA256 |
|---|---|---|
| `apps/web/src/app/chats/page.tsx` | `65ffe5d15d21dc9336b700b6153adebf48bdd276ed7b7554a1817b2aa122a923` | `65bde7302085aaf477647d9b6408be82ec3e6710bf71f64c5aedc30e98fc66e8` |
| `apps/web/e2e/chat-notes-race.e2e.ts` | `不存在（新規）` | `be0d97b327f28fd2a49422394235df36d0325c4f6439169c4c8f69ea36ac5430` |

## 判定・保持契約

限定差分に阻害findingなし（静的確度高）。dirtyは入力イベントで同期的にtrue、revisionも加算する。loadChatDetailは既存epoch/selected ID/detail.idの一致後に、cleanの場合だけserver notesをsetする。同一chatのstatus/save refreshがdirty draftを上書きしない。

saveはclosureのselected ID/notesと開始時revisionを保持し、成功時に現在selected IDとrevision両方一致した場合だけcleanとする。保存中の追加編集はrevision差でdirtyを保ち、成功後GETからも守る。失敗ではclean化しない。A→B→Aは選択effectがrevisionを進めるため同じIDに戻っても旧saveでcleanにならない。旧saveがB選択中に返った場合は既存loadChatDetail入口ID gateでB loadのepochを奪わない。

通常save成功でrevision一致ならcleanとなり次のserver更新を受け入れる。空文字メモも既存notes payloadのまま保存。選択変更時dirtyをreset/revision更新し別subjectへdraftを持ち越さず、handleSelectChatのnotesクリアとdetail loading表示も維持。次の未対応/戻る/deeplinkは同じselected effectを通る。API引数/認可判定/chatMutationAllowed/永続形式/localStorage保存は変更していない。

catchでerror表示、finallyでsavingNotes解除する範囲も不変。旧save失敗のerrorが現在の選択へ表示され得る点や全画面共有savingNotesによる待機は既存挙動で、今回解決したとはしない。複数tab/同一メモのserver競合を防ぐETag/CASは追加していない。detail refreshで入力欄が一時loadingに隠れる既存挙動も維持。

## テスト評価

新Playwright test全文確認。合成session/accounts/chats/friend routes、PUT待機promise、永続役storedを用い実画面を操作する。保存中編集→再保存、status refresh、clean正常保存/空文字、失敗→refresh→retry、A→B/A→B→Aの6case。payload/idとstored検証があり、単に入力の見かけだけを見るテストではない。fixtureの汎用APIは合成返却、非local外部はabortする構造。実API auth/DB/providerは検証していない。

親browser.log末尾6PASS、web.log55files267PASSを読取確認。typecheck.logは空であり申告tsc0はそのファイル単独から証明できない。独自Playwright/unit/tsc/build実行なし。旧P REDのtrace/screenshotはbrief参照のみで今回は未読。

## Coverage・実施コマンド・制約

読取: F35 brief/input、git diff page.tsx、新test全文、apps/web/AGENTS.md、pageのloadChatDetail/selection effect/handleSelectChat/status/save/input/描画gate/次の未対応選択、setNotes/setSelectedChatId参照検索。既読rootの機密/範囲規定も適用。周辺出力一部truncateは全差分と必要箇所再読で補ったがpage全文監査ではない。

cat/sed/rg/git diff/git rev-parse/git show/Python hashlibを実施しP hash/HEAD一致、最終W2hashを上表へ記録。新W manifestは依頼時提示されていないため期待Wとの照合ではなく実ファイルの採取値。source/Git変更・外部送信・実データ・spawnなし。この記録のみ書込、commit/patchなし。

統合時は上記W2hashと主担当最終artifact/hash/検証結果を照合する。選択effectを含む通常React commit順を前提としたブラウザ経路のレビューで、全非同期UI/全auth安全を保証しない。新たな修復阻害依存なし。fresh全体最終レビューとは数えない。
