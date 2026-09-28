# F27 FIX — 下書きをLINE利用者で分離
RUNNING。P=362737be415b11577535486a6d68f7d67edd728b、primary/dev。CONFIRMED_BUG/P1、actualChromiumで別subjectに氏名復元。書込draftStorage.ts/test、PatientIntakePage.tsx、e2e/liff.mock.ts、新draft browser test。
意図的差分: 新規/既存患者の下書きread/write/clear/sweepをliffId+初期化済みLINE userIdで区切る。未帰属legacy draftは自動first-claim移行しない（患者listの権限は未送信入力の作者証明ではない）。旧key/valueを一括削除/改変せずそのまま保持。新prefixは旧sweepの対象外。旧helper exports/保存envelope/API/submit/idempotency/認可は維持。旧下書きの自動復元停止はprivacy修復による意図的差分、所有根拠なしの安全な移行は未提供。
既存のlocalStorage保持機能自体と24h TTLは継続。利用者IDは端末内区分でserver認可代替にしない。新規server API/外部依存なし。
Acceptance: subject A入力→B空→B入力→A復元、同主体reload、別LIFF分離、別利用者listがAのdraftを削除しない、同主体の失効patientはsweep、旧key byte保持/非復元、storage不可時編集保持。既存F04/F03browser回帰、LIFF unit/typecheck、全verify、build成果物必要範囲、限定review、patchreplay。実LINE/WebView未検証、synthetic browser/auth fixture。

検証: LIFF unit28files205PASS、Chromium11PASS（新4/F04等既存7）。PのpageとdraftStorageを別名tempに取り出し、App importだけtest pluginで差替えたREDは新4casesすべてFAIL。別patientのB一覧がA下書きを消す、同patientを共有するBへA未送信回答を表示することもREDで確認。current testsは4つともGREEN。旧keyそのまま保存/新keyを旧sweepから隔離するunitを追加。comment変更のみ後に追加、意味を変えず全verifyへ。temp bytes照合保存後削除、既存sourceの巻戻しなし。F27-input/patchに5paths全hash/isolatedreplay。

最終全体検証: 制限環境env -i PATH/LANG/TMPDIR/CI/NO_COLORで`pnpm verify:ci` exit0（integration-F27-verify.log、全workspace build依存/typecheck/test/script/migration gate）。`python3 .../F27-artifact-run.py`は通常LIFF SDKを含むproduction Vite build exit0、distコピーだけのHTTP配信からChromium startup error guard1PASS/runtime0。compiled成果物hash/bytesはF27-artifact.json。下書き操作のbrowser11casesはdev build+SDK mockでありproduction成果物でLINE認証を再現したものではない。Node26/pnpm11、CI Node22/実WebViewは未実施。
旧export署名/key/envelopeは保全し、新user key/sweep helper3exportsを内部moduleへ追加。route/API/submit payload/外部package公開入口は変更なし。旧未帰属記録の所有者確認/安全な自動移行は未提供、既存bytesを残す。古い配備済みアプリ自体のfirst-claim挙動まで変更することはできない。

INTEGRATED `3be2dbf1bed931fbf98cca4e40f934fce2058ba4`。限定review全文と5hash一致を親確認、旧client rollback時のprivacy再出現/旧未帰属keyのTTL限界も受入記録へ明記。全体完了ではない。
