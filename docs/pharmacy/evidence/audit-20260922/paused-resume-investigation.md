# 共通送信の一時停止後再開

P=W=10d1198cfb1d7a2d2154b1d911288ce9ed8b6e9e、primary/dev。F25統合後のconsumer再探索。製品コード未変更。

CONFIRMED_BUG/P2: continuityの実pausePatientContinuity後に送信を試みるとprovider呼出0でskippedだがledger attemptedを残す。後に同じobligationをactiveへ戻して25時間後に再試行しても、sharedsender created_atの24h horizonでreconciliation_requiredとなりdeliverがskippedを返す。未送信が確実な初回保留なのに再開不能。既存dispatch-stateの16分再開caseは通るが長期停止を覆わない。

再現: paused-resume-case.txt (永久testのコピー)でDateのみfake、最初NOW2026-09-22T00Z、再送25h後、最初のpauseは実業務関数、再開activeはSQLによる合成状態注入。実claim/delivery/sharedsenderとbootstrapSQLite FK/check/trigger有効。provider/credential/beta binding stub、実外部送信なし。`env -i PATH=... LANG=C.UTF-8 TMPDIR=... CI=true NO_COLOR=1 pnpm --dir apps/worker test src/custom/pharmacy/continuity/audit-paused-resume.test.ts -t 'does not send after patient pause'` exit1/1FAIL18filtered、期待sent/実skipped。tempをcaseとbyte一致確認後削除。

F26候補: provider未呼出の一時停止と過去provider結果不明を区別する。F25のvalidityだけのknown-unsent failed処理を共通の一時ゲートへ適用する必要性を確認する。sharedsender final paused/patient_retryable/operations_blockedとpostclaim/final patient retryableにも同じ保全形があるが、それぞれの到達/復帰条件は追加検証前。恒久blockedの意味や本当にunknownの24h horizonを緩めない。まずcontinuity25hを永久回帰へ、tenant finalpause/unknown維持を検証して凝集した範囲を決める。

未実施: 修正/追加fullcheck/freshreview。F25のpassing結果はF25のみ有効。F26 source変更前にはF26briefとP/Wを書き起こす。GitはPLANS+evidenceだけdirty、live processなし。
