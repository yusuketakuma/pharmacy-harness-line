# AUDIT-UI-20260922 完全受入記録

- owner/thread: `/root/audit_db`を再利用。P/W=`9d386163a7452e2515fe1d537316d83780040673`、UIソース変更なし。
- 状態: 限定静的調査完了、C08/X05全体はPARTIAL。変更path/commit/patchは非該当。
- 指示: root/LIFF/Web AGENTS。API認可/CAS/payload/永続形式/有効テストを保全。

## Findings

1. **F-UI-01 CONFIRMED_BUG/P2/確度高**: MedicationFollowUpPageはbusyId=A中にBのbuttonが有効。B送信→busyId=B→未完了A有効。どちらかfinallyで全busy解除。handler guardなし/new idempotency key発行。UI二重操作防止違反。DB二重確定は未確認。親F03採択。既存testはdisabled文字列assertだけで競合を検出しない。
2. **F-UI-02 CONFIRMED_BUG/P2/確度高**: PatientIntakePage latest/accessは[selectedId] effectのみ。失敗後onlineはlist/policyだけ再取得しselectedId維持。同じ患者選択はearly return。単一患者の一時失敗後intakeReady=falseのまま送信不能、access errorも「確認しています」と表示。policy専用retryはあるが患者別retryなし。親F04確認対象。retryで入力消失/古い応答の採用を起こさないこと。
3. **C-UI-03 EVIDENCE_BASED_CONCERN/確度高**: draftStorage新規プロフィールkeyは`patient-profile:new:${liffId}`で主体IDを含まない。別LINE主体が同じbrowser storageで同じLIFFを使うと前利用者の下書き復元が可能な形。実際のWebView/storage分離・アカウント切替条件は未確認、漏出確定としない。legacy移行もfirst-claim。患者ID draftは一覧所有確認/scope sweepあり。勝手に既存下書きを一括削除しない。
4. **C-UI-04 EVIDENCE_BASED_CONCERN/確度高**: Web auth-guardはpathname再確認開始でcheckedをfalseに戻さず、次childrenが先にmount。focus/他tab logout再確認なし。fetchApi 401はstorage削除/full navigation、server認可回避は未確認。要求に照らして採択判断する。

## Coverage

- REVIEWED静的: PatientIntakePage選択/load/profile save/intake submit/通知変更/代理取消（末尾表示全体はPARTIAL）、MedicationFollowUpPage/api、ContinuityPage/api、draftStorage、request.ts。
- Continuity: epochによる旧list破棄、busy、optimistic rollback、reloadを確認。実競合/server状態未検証。
- draftStorage: TTL/legacy migration/scope sweep、request: LIFF scope/Bearer/固定error確認。
- Web: AuthGuard/AppShell/api session/parser/fetchApiの対象部分。AppShellはaccount keyでchildren remount。
- PARTIAL: login/password/sidebar logout、intake関連tests。followup test全文は読取り。全UI/全tab/offline/実WebViewは未確認。

## コマンド・結果・未実施

`git rev-parse HEAD`, `rg --files`, 対象`rg -n`, `cat`, `sed -n`で読取り成功。検索matchなしexit 1あり。切断部分はレビュー済みに算入しない。test/build/browser/network/実データ操作は未実施。親F02とファイル競合なし。

統合条件: F03/F04のFIXと挙動回帰、C-UI-03の主体条件、C-UI-04の採択判断。固定Iで独立レビューを行い、この修正前調査を最終PASSとして流用しない。
thread: 完了受領、close APIなし、未close。追加threadを開かない。
