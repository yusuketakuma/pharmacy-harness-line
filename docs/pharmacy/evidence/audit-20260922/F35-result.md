# F35 受入記録
F35 FIX / CONFIRMED_BUG/P2、primary/dev。P=abda3847979e19b906ebe3f81c61cfac03cf901c、H/Bはbaseline.json。W2pathsはF35-W.json、全差分はF35.patch。

## 修復・契約
loadChatDetailが同じchatの未保存メモを無条件上書きしていた。入力dirtyと単調revisionを追加し、保存成功が同じ選択・編集revisionである場合のみcleanとする。選択変更はrevisionを進めdirtyをresetするためA→B→Aにも対応。status reloadでもdirty draftを保持する。API path/payload、認可、保存形式、旧selection/epoch fence、選択変更時のdraft破棄は維持。新しいbrowser永続保存なし。旧テストの削除・緩和なし。

## 検証
- 初回調査の実ブラウザ再現: chat-notes-browser-final-red.log、入力Bが保存Aに戻る。スクリーンショット主担当目視済。初回のmileage fixture不備は製品欠陥証拠から除外。
- python3 docs/pharmacy/evidence/audit-20260922/F35-browser-run.py: コピーしたtracked sourceと合成APIだけのNext/Chromium。Playwright6PASS（11.4s）、外部requestはabort。保存中編集/再保存、status refresh、正常空文字保存と後続server更新、失敗/retry、別chatと元chatへ戻った後の遅延save。
- 同一最終6caseを隔離Pのpage.tsxへ適用: F35-final-red-run.py/log、5FAIL1PASS（37.2s）。元checkoutは巻戻さず、最終に隔離copyをWへ戻した。
- env -i PATH/TMPDIR LANG=C.UTF-8 CI=true NO_COLOR=1 pnpm --filter web test: 55files267PASS。
- 同環境 pnpm --filter web exec tsc --noEmit: exit0。空logと別にF35-execution-status.jsonへ端末session94742終了コード記録。
- git diff --check exit0。独立git rootの隔離Pへpatch適用、2paths全bytesがW一致（F35-patch-check.json）。初回は入れ子dirのgit applyがskipしてassert失敗、専用git rootで修正し記録。製品テスト失敗ではない。
- F35-limited-review.md親全文読取・W2hash一致、阻害findingなし。再利用threadの限定review、fresh全体最終reviewではない。

## 制約・再探索
api.chats.update→fetchApiが非2xxでthrowする既存経路を静的再確認。API/Worker/DB/共有consumerは変更なし、F34/F33の不変workspace検証を再利用。製品描画はブラウザで検証、今回レイアウト/style変更なし。module/package/entrypoint/asset/export変更なし、追加production build/配布物起動なし。CI Node22/実API認可/実DB/provider/複数tab競合は未検証。既存の選択変更時draft破棄、旧save失敗errorが現選択に出る可能性、全画面共通savingNotesは変更していない。
全体C01–C12/X01–X08はPARTIAL、F-DIST-01信頼hash不明とfresh全体reviewは未解決。PLANS/evidence既存差分保全、push/deploy/本番・外部変更なし。

統合: 2pathsのみlocal commit 55c170b1c4ec61c54ef1a93bffb892f36d08c529。
