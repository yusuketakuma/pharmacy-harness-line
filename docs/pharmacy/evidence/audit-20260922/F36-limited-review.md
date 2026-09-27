# F36 限定 read-only review

ID F36-LR / audit_db。P `55c170b1c4ec61c54ef1a93bffb892f36d08c529`、HEAD一致。既存thread再利用、fresh全体最終独立レビューではない。

| path | P SHA256 | レビューW SHA256 |
|---|---|---|
| `apps/worker/src/custom/pharmacy/data-subject-requests/repository.ts` | `218af0825f406b0c2afb9e3bc5cfc98301b74e7e211c34987964c9009aa0639f` | `365ff78bb7c67a6eeab35d2d79653a75f1eeb4f9776d94fc4c01c427643d73d6` |
| `packages/db/test/custom_038_pharmacy_data_subject_requests.test.ts` | `2a194b9460e5d79282703e9f687500295675f62501a80f789ecf5e3233cdea6e` | `9b24ea5cc62ad9bfdfab1ab027d41975725016a10c1190e39815091f0f30dbae` |

## 結論

新規createのepoch逆戻り修復は静的に妥当。ただし既存transitionのwildcard guardに残存競合を発見し、親へ通知済み。『並行処理でも全hold状態を保全』という広い判定は留保する。malformed date候補は混ぜない。

新規exact INSERT SELECTは現在のtenant/account/owner/(patient or *)のMAX+1を同batchで計算する。初回0+1、exact/wildcard乖離時は高い方+1、別accountは参照しない。wildcardは直前exactが作ったMAXを再利用し同世代へ進む。新規事前readによるlost updateは追加しない。家族は共有wildcardから世代を引継ぎ、別患者exactを直接書き換えない。bind順は新規時だけnextEpoch placeholderを取り除き、key/status/release/reason/time/request/account/status/versionに一致する。

既存expectedHoldEpochありのAPI/caller/CAS/request version/監査field/保存schema/期間は差分不変。create患者/tenant/account/ownerはDB SELECTから導出し、入力ownerを新たに信用しない。D1 batchが順次transactionとして実行される前提で、同時createはserializeされた各MAXを使う。

## 残存finding F36-C1

重大度: P2相当のhold状態整合性（削除被害未確認）。確度: 静的SQL経路として高、独自実行再現なし。導入元: 新規差分ではなく既存guard連鎖。

先行transition Aがexpected epoch eを読んだ後、Bが一段だけepochをe+1へ進める。A batch内eventはe比較で0行、exactもe比較で0行。しかしwildcard source guardはnextEpoch=e+1を比較するため通過し、Aの古いstatus/releaseをwildcardに書く。request UPDATEはeventIdが存在しないため0行。commitTransitionはbatch確定後にchanges!=1を見てthrowするだけで、SQL0行はtransactionエラーではないためwildcard書込はrollbackされない。exact/ownerの状態が乖離し、新owner unknown/heldを古いreleasedで上書きし得る。readRetentionFence等の残るexact防御もあるため、即削除可能とは断定しない。

今回追加ABA回帰はB create→verify→assessでe+3となるため、e+1専用穴を検知しない。最小検証は同じ実SQLite interleave fixtureでA resolve前のBをcreate一回のみにするか、fence writerが一段進める形にし、A conflict後もwildcard新unknown/heldが保全されることをassert。修復候補はextrasが当該batchのeventId成立を要求する等の所有証拠であり、単に数値e+1一致だけをexact成功の証拠としないこと。

## 読取・検証・制約

F36 brief、git diff2path全文、repository eventStatement/holdEpochStatements/commitTransition/create/resolve該当箇所、test D1 adapterと追加5case全文を読む。testは実SQLite transaction adapter、2方向epoch乖離・別account・家族・反復・旧assessment ABAをassertし、監査/元request/held保持も確認する。追加5caseという数はparameterized2を含む。親報告RED2FAIL14PASS、near初期16PASSは本担当未実行/ログ未読であり独自成功としない。最終19case/full/native検証中という報告も未完結果として扱う。fixture失敗は親が報告した試験準備ミスで、製品findingと混同しない。

git diff/sed/rg、git rev-parse/git show/Python hashlibでP/W採取。W manifest期待値は今回提示されておらず実ファイルhashの記録。source/Git変更、独自test/native/外部/実データ/secret/spawnなし。この記録のみ書込。commit/patch作成なし。統合前にF36-C1のactualSQLite再現・判定と最終固定hashの検証を主担当で結び付ける。全DSR/retention完了とはしない。
