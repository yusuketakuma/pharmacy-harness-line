# F28 文書限定レビュー

ID F28-LIMITED-20260922、担当 /root/audit_db。既存thread再利用、fresh全体最終独立reviewではない。
P=3be2dbf1bed931fbf98cca4e40f934fce2058ba4。W全2hashをF28-inputと照合、一致。

判定: PT-01の必須tenant設定例欠落は解決。README環境表とREADME/MCP index冒頭コメントのJSON例だけにLINE_HARNESS_TENANT_IDを追加。getClients/getEnvOrThrowが要求するAPI_URL/API_KEY/TENANT_ID/EXTERNAL_API_KEYの4keysが両例に揃う。placeholderは実secret/実tenantでなく、tenantを任意queryで認可する変更でもない。両追加位置は既存JSONのcomma構造を維持。
runtimeコード/型/依存/権限/SDK初期化に差分なし。index.tsの変更は閉じた冒頭block comment内のみ。新API/永続形式なし。旧設定は欠落時の失敗挙動を変更せず、正しい設定手順を示す修復。

読取: F28-brief/input全文、対象2file差分、example-tool.ts12–28のgetEnvOrThrow/getClients。前回plugin-template調査を再利用。親F28-example-checkのJSON parse結果は報告として受領、本reviewでは再実行せず静的照合。
実施: cat/git diff/sed、Python read_bytes/hashlib/git show/git rev-parse。P/W全2hash一致。source/Git変更なし、本記録のみ作成。test/build/外部/実データ/spawnなし。実行失敗なし。
findingsなし。PT-02その他template懸念はF28で解決したとは扱わず別件として保持。doc-onlyなのでruntime tests/build再実行不要という方針に異論なし。最終Wのhash一致を確認して統合し、fresh全体reviewに数えない。

| path | P SHA256 | W SHA256 |
|---|---|---|
| packages/plugin-template/README.md | 85d85b522c149818a6d3b7e00528ab01f1f1642d499edf9dd7dc94078c198f4e | aa48a3029e83bebf286530b5170a669e4c829d0dd172de8c03318816be0ab9d6 |
| packages/plugin-template/mcp-server/index.ts | d481dc77fcddb5436158808cb5045904bd4852ab96e0b2ffe6776ed7e3d05628 | b952bf294cf44d4bfd266f8e9b699cbf55f29c73bb73d24693d6c2a0f7cde83e |
