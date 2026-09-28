# F27 限定read-onlyレビュー

ID F27-LIMITED-20260922、担当 /root/audit_db。既存thread再利用、fresh最終独立reviewではない。
P=362737be415b11577535486a6d68f7d67edd728b。W全5path SHA256と入力を照合、一致。

## 判定・保持契約

新規修復阻害findingなし。新規/既存患者draftのread/write/clearと患者list後sweepがliffId+LINE userIdに変更され、同patientIdを共有する別主体の未送信回答を混同しない。患者list権限をdraft作者証明に用いるlegacy adoptionを停止するのは意図的privacy修復。
user prefixのliff/user成分はencodeURIComponentで区切り衝突を防止。患者IDは固定主体prefix末尾なので別主体のprefixへescapeしない。save/loadは共通PREFIXを足し、sweepUserは共通PREFIX+userIntakePrefixを渡すため対象keyが一致する。旧intake prefixと新user-intakeは異なり旧sweepから新draftを保護。
旧helper exports/key/value envelope/TTL/storage例外処理は維持。旧legacy bytesは現pageからread/adopt/clearしない。未帰属dataの自動復元停止は意図的な互換挙動変更であって、形式破壊/削除ではない。
LINE userIdは初期化moduleでliff.getProfileから取得し、未初期化ならthrow。mainはinitLiff成功を待ってrenderする。subject欠落を空文字fallbackとして共有keyへ書く実装ではない。server認可・ID token送信は変更しない。
PatientIntakePageの全差分にあるclear/save/load/sweepは新scopeを使用する。既存操作epoch/submit/idempotencyには差分なし。e2e mockのsyntheticSubjectはtest fixtureのみでproduction identity入力を変更しない。

## rollbackと残余リスク

旧clientは新keyを理解せず新draftを復元しないが、旧sweepも消さない。新clientへ戻れば同主体で復元できる。一方、旧clientへrollbackすれば保存済みlegacyを旧規則で復元するため元のprivacy欠陥は再出現し得る。bytes/形式のrollback互換とprivacy保証は別。『旧clientでも主体分離が維持』とは記録しない。
localStorageは暗号化/OS利用者分離ではない。端末・同origin scriptからの閲覧防止を提供する修復ではない。旧未帰属keyは自動load/sweepしないので現版による24h経過時の削除も行われず保持され得る。これは依頼されたlegacy bytes保全とのtradeoffであり、全legacy PHIが24hで消えると主張しない。
同一mounted SPA内でLINE主体が外部から変わるケースは本testsのpage navigation/reinitとは異なる。identity moduleは初期化時の値を固定するため、reloadなしの外部LINE account切替を検知する保証は未確認。現修復を超える全端末セッション管理として扱わない。

## 読取・テスト

F27-brief/input全文、draft-subject-investigation関連段落、draftStorage/page/test全差分、draftStorage load/key/sweep周辺、liff-auth全文、main初期化順、e2e新file全文、liff.mock差分。page全体/全browser設定は今回再読せず過去UI調査を再利用。
新browser4casesはA→B→A/new patient、legacy非復元・残存、同/別患者IDのA/B questionnaire隔離と非削除を確認する構成。unitは別LIFF/user、separator collision、同主体失効sweep、legacy bytesと旧sweep保護をassert。実LINE/WebView/storage拒否の新実行は本reviewで行わない。既存storage例外処理の変更なしは静的確認。

## 実施・統合

cat/git diff/stat、rg/sed、Python read_bytes/hashlib/git show/git rev-parse。全5hash一致。本記録以外変更なし。test/browser/build/外部操作/実データ/spawnなし。親unit205/browser11は報告として受領し独立再実行でない。full/buildは依頼時進行中。
primaryの最終Wと実行証拠を照合し統合。新clientの自動legacy復元停止とrollback privacy限界を保持。fresh最終独立reviewには計上しない。

## P/W SHA256

| path | P | W |
|---|---|---|
| apps/liff/src/custom/pharmacy/draftStorage.ts | dde126da8a49b652ce1a53eb22bfef132249653593128d12087cf71fc8c4b609 | 87fcb7d7fac874ca4720e6bafb0534764704ec93386f118a622bf4d833d8cb51 |
| apps/liff/src/custom/pharmacy/draftStorage.test.ts | 2ce8100bdb3c561166dea5d035f6ac40651b8268c2f344202b076a510c1cf3fd | 72e0acf2b32307120d95573d67dab33ae7956f743b57f101476cf7d51c61d99c |
| apps/liff/src/custom/pharmacy/intake/PatientIntakePage.tsx | 7f0e0cdf289642199989fb70017e59686b1af9042d1c8cc5dea9839f76d1f82c | bb43a3ec8a00c9c23e13c48c223ea36c31cda705f05a1081eec908cf3dda9206 |
| apps/liff/e2e/liff.mock.ts | aab9e8c1a32bdbefbb8ec94234a43f6489aa2773218f08e7507872f340feddf5 | edc9014f409ab8c77a3f8bb3d3d5ae3bd520204bc45f3a472dd803989bd1b0a8 |
| apps/liff/e2e/patient-draft-scope.e2e.ts | 不存在（新規） | 75414345af0c482a8181aa0dd6a5063a7a56611ed0ee31f8e383fc26b1a585be |
