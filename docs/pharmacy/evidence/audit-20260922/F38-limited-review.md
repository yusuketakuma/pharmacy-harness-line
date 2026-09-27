# F38 限定 read-only review

ID F38-LR / audit_db。P `3158e7c337a3d43022b1db6fd0a4ce0fc4877257`。HEAD/P/W全5hash一致。既存thread再利用、fresh全体最終レビューではない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts` | `07892f35562cf43e5f7d01bbf582263d4ddc9b002acd89400606e448e4644b30` | `bc48dbb223979ce4ac300516bdae1a77cd160de7fd036dcafdbcb8d72b04e3f8` |
| `apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.test.ts` | `19800a45bf996693664576df89a2b4fe84fb2afade8fa23a5da6bfb5c5402375` | `ff8a3d292b47a8b51a4cc45dc908aba2f88df2c4b576a350f6ce6c7d828183ae` |
| `apps/worker/src/custom/pharmacy/retention/fence.ts` | `24107221be41407dc1a08a3d530a5d3538db4093378134c403228d5978da5123` | `434f38bc9e1f54604cd18afb6c1234417900deccd5b2021cbe68a46ee2a1ee02` |
| `packages/db/test/retention-d1.test.ts` | `16a199b8612baac17f5551f77d9e32303f28fdaed9818bc50f694c501d32b475` | `2778658fc1a8eb97d779903f299780ae51cafd301c1a51d962e40ba2302ffb5a` |
| `apps/worker/src/custom/pharmacy/prescriptions/retention-purge.test.ts` | `862a562c6f8b06347087445472b8d486fe79d87bcefd09fc182e6424828f739a` | `3488ff30771f4d7e711e2a22a519cd740e1e90abe85ab9f383f5e7d46634ac28` |

## 判定・契約

限定差分に阻害findingなし（静的確度高）。JSはshape/finiteの短絡評価後にtoISOString一致を確認するのでinvalid DateでtoISOString例外を新たに出さず、2月30日/非閏年2月29日/24時の自動繰上がりをunknownへ戻す。latestPhiRecordedAtは1sourceだけ不正でも全体null、assessPatientRetentionは既存catchでunknown。overlayも同じcanonical判定を持つ。適法な閏日からsetUTCFullYear(+3)で3月1日となる既存期間計算を変えていない。

SQLはlength24かつstrftime(...,'+0 seconds')と元値が等しい時だけexpiredを認める。無効入力のNULL結果は既存COALESCE(...,0)→NOTでblockへ。正規化により別日になる値も不一致。now placeholder数/位置、hold0/hold1/status条件、raw release文字列の比較、tenant/account/owner/patient consumer scopeを変更しない。valid canonical UTCなら辞書順と時系列一致。GLOBのpattern上限依存を除去し、新schema/export/dependencyやsource省略なし。

## 回帰の検出力

unitはinvalid4種と有効閏日anniversary。native source testは有効recent sourceと併存する不正owner日付でもnull/unknownを確認。native shared predicate testはvalid leap、境界ちょうど/1ms未来、invalid各種/JST/date-only/null、hold0各statusを実D1で確認する構造。

実consumer2caseは不正activeDSRから実prepareRetentionFenceがexact/owner unknownへ進み、R2 put/delete0、file ready、監査purge空をassert。別3caseは一度released fenceとCLAIMED intentを作成し、DSR日付だけ変更して最終commit SQLを呼ぶためJS再判定に依存しない。valid leapdayはDELETE_COMMITTED、invalid day/monthはCLAIMED保持。これにより常にfalseとなる修復も検出する。incoming consumerの専用追加回帰はないが同export predicate利用は先行調査済み。全incoming workflow成功の実証には広げない。

## 証拠と制約

F38 brief/input/W、全5path差分、新テスト追加全文を読む。既読legal-hold/fence/consumer本文を再利用。native.logとdb-near/worker-nearのsummary、native corrected RED末尾を確認。独自test/実D1/perf/fullverify実行なし。親報告のWorker最終RED7FAIL59PASS、近傍66+22PASS、verify0、native exit0/egress0は独自実行ではない。RED補完の初期失敗履歴は削除しない。性能50/500/5000中央値0.200→0.220、0.293→0.507、1.447→3.681msは親申告、固定閾値内だが追加正規化コストあり。本担当性能ログ再計算はしていない。

実施git diff/cat/tail、git rev-parse/git show/Python hashlibで全hash照合。source/Git変更・外部・実データ・secret・spawnなし。作成物は本記録のみ、commit/patch非該当。最終統合時に5hashと親最終verify/native/性能/isolated replayを結び付ける。正規nowは既存caller契約、全法制度/期間妥当性は対象外。元malformed候補の今回触れた3JS+shared SQL境界を解消と判断するが、全repo日時検証の完了ではない。

証拠数の区別: 実際に読んだF38-worker-near.logは追加consumer前の61PASSであり、最終66PASS申告とは異なる時点。db-near.logは22PASS、final-red-native-corrected.logは2FAILを確認。最終66PASSはこの担当が当該別ログを照合した数値ではない。
