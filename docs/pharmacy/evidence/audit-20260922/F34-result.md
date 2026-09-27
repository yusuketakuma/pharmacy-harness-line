# F34 受入記録

F34 FIX、CONFIRMED_BUG/P1（F32と同根の未被覆privacy経路）、primary/dev。P=f3d3dc401a8859dd137bb9163752e9bb3425c124、H/Bはbaseline.json。WはF34-W.json3paths、F34.patchは新testも含む。

## 根拠・変更
chatsのPOST/PUTでrequest JSONのSyntaxErrorに含まれる合成PHI_MARKがconsoleへ出る。残るDB例外sinkにもraw Errorが渡り、conversationsではHTTP500 errorにString(err)が入る。実Hono/実helperによる14回帰caseで旧コード14FAIL。4つの不正JSONcaseは実SQLiteと実認可helperを通し、PUTchatの実対象解決後のparseを含む。10faultcaseはDB.prepareに機密markerつきErrorを注入しsinkを検証、DB障害で実際にPHIが返った本番被害の観測ではない。
chats8catch、conversations2catchを固定event・空fields・errorlevelへ変更。conversations500のerror値は固定Internal server errorとする。try/catch範囲、成功レスポンス、early return、status/JSONkey型、保存・認可・外部送信順は維持。例外をrollbackする新保証なし。旧テスト削除・緩和なし、新14case追加。

## 実行証拠
共通: env -i PATH/TMPDIR継承 LANG=C.UTF-8 CI=true NO_COLOR=1、Node26.6.0/pnpm11.25.0。
- pnpm --filter worker test src/routes/crm/chat-error-privacy.test.ts: F34-red.log、session52282 terminal exit1/14FAIL。product Pは未変更でtestのみ追加、巻戻し操作なし。12caseはログmarker漏出、conversations2caseはresponseにmarkerが含まれ固定error不一致。
- pnpm --filter worker test [新privacy、manual-message、chat-time、conversations-tenant-scope、chats-list、chats-tenant-pair、logging-privacy]: F34-near.log、session10420 exit0/7files82PASS。新caseは固定500と余分fieldなし構造化event、log/warn/errorのmarker不在、badJSONで既存notes/operators不変を検証。
- pnpm --filter worker test: F34-worker.log、session46762 exit0/271files3020PASS。
- pnpm --filter worker typecheck: F34-typecheck.log、session48386 exit0。
- git diff --check: exit0。隔離PへF34.patch適用、3path全bytesがW一致。
- SDK http.tsのerror:string→LineHarnessError(message,status,path)、MCP get-conversationのerror文字列化を静的確認。HTTP500/key/型と例外クラスの契約を変えず、公開内部詳細だけ除去。依存のconsumerテストはsource不変かつF33全体verifyを再利用、新たなSDK/MCP実行専用検証なし。

## 制約・統合
固定の合成tenant/staffでrouteをmount、fullapp middleware/薬局operators到達/本番被害は証明しない。operatorは薬局allowlistにより通常拒否される既存境界を変更しない。DB.prepare故障のfaultは実provider障害ではない。
F32 loading/sendの固定eventは維持。依存内部や他moduleの全log漏出まで解決したとはしない。loggerのerrキーへ任意Errorを渡す全repository経路は別調査。
新schema/publicsymbol/entrypoint/package/asset変更なし、既存純粋loggerをconversationsへimport追加。新たな配布物生成/全Worker startup/nativeWorkerd/CI Node22/実外部通信は未実施。関連ソース変更がWorkerに限定されるため、F33全体verifyの不変workspaceを再利用しWorker全体を更新検証した。
限定レビューF34-limited-review.mdを親が全文読取、3hash照合し受入。阻害findingなし。fresh-context全体最終reviewは未完。既存PLANS/evidence差分は保全、3pathsだけlocal commit abda3847979e19b906ebe3f81c61cfac03cf901c に統合。外部操作なし。
