# D1 cron 負荷の見直しとローカル検証

対象: `f5164efce3456be17dd4f32722fd901b25a8b50d`（作業開始時HEAD、v0.36.5）。
本番v0.36.5はActions run `37107517514`で配備済みという引継ぎを前提とする。
今回の実DB別`rows_read`、D1上限超過の真因、追加migrationの本番適用状態は未確認。
本資料はローカル実装・合成データ検証であり、本番改善の実測報告ではない。
push、PR、配備、remote SQL、設定・認証・課金変更、外部送信を行っていない。

## 現行周期の仕事

`apps/worker/src/index.ts`のscheduledと`wrangler.toml`を確認。cronは5分と6時間。
以下の「書込み・外部呼出し」は既存処理の説明であり、今回の作業で本番実行したものではない。

| 周期・条件 | 読取り | 書込み | 外部呼出し |
|---|---|---|---|
| 全tick | active tenant/account一覧1文、generic判定のaccount capability参照（最大account数、薬局検出で終了）、token refreshが一覧を再取得 | token期限が近いaccountのみ更新 | 期限が7日以内/未設定のaccountのみLINE token API |
| 全tick・薬局含む | Meet期限・due reminderと受信者・認可・資格情報 | claim、期限処理、送信結果 | due通知のみproxy/LINE |
| 5分・薬局含む | outbound test replay1文、accepted scenario repair1文、unsent repairの2文、期限retire1文 | CAS、履歴投影修復、期限retire | test replay対象のみLINE |
| 5分・薬局含む | webhook inbox recovery、服薬follow-up due、緊急避妊appointment reminder生成/claim/最新context | claim、結果、reminder生成 | due/復旧対象のみproxy/LINE等 |
| 5分・薬局含む | Myna EXPIRED、緊急避妊status events各1文。従来は72時間履歴＋sent除外 | 既存senderのidempotency claim/結果 | 適格な候補のみproxy/LINE |
| 6時間・薬局含む | receipt保持期間、処方画像保持、緊急避妊保持、処方通知再試行、continuity/validity due | 保持期限処理、claim、結果 | 対象がある場合のR2処理・通知 |
| generic有効時 | stalled/stuck復旧、booking/event/webinar reminders/follow-ups、step/broadcast/reminder配信、health、mileage。6時間にはinsight、booking expiry等 | 復旧、配信claim/投影、mileage等 | 対象に応じLINE/insight等 |

generic経路は既存のfail-closed判定を維持した。今回の変更は表のoutbound再調整とMyna/緊急status通知・関連expiry索引に限定する。他のジョブ全体のD1文数・CPU・外部呼出し件数は計測していないため、以下の予算をシステム全体の予算として扱わない。

## 採用した構造

1. `030_custom_082`は9索引を追記。openのretry期限、attempt済broadcast、未attempt scenario reply、現在claimのpayload、claimを持つpaused enrollment、Myna/緊急statusの時刻範囲、account内のactive expiryを対象にする。既存索引は残す。
2. accepted scenario repairは`friend_scenarios`のpaused/current claimを起点にし、payloadをenrollment＋claimで検索する。`CROSS JOIN`で履歴起点への逆転を防ぐ。tenant/account/friend/scenarioの照合、更新時のclaim CAS、ORDER/LIMITは維持する。unsent repairにも同じpayload索引が効く。
3. `031_custom_083`はD1内の`pharmacy_status_notification_work`を追加する。MynaのEXPIRED遷移、緊急status eventのINSERTと同じトランザクション内でtriggerが仕事を登録する。旧Workerの書込みでも登録される。仕事にはaccount、内部source id、retry key、時刻、状態・claimのみを保存し、通知内容・患者氏名・資格情報を複製しない。
4. 5分cronは`kind + due_at <= now + state=pending`の索引範囲だけを取得する。各種50件の上限を維持。完了・期限切れ履歴はpartial indexから外れる。選択候補のaccount/source照合、通知前の最新eligibility/credentialチェックは維持する。
5. claimと完了処理をそれぞれD1 batchにまとめる。空ならbatchを発行しない。同じ仕事を同時に選択しても`state=pending AND due_at<=now`の更新が成功した側だけが送る。claim tokenが古い完了更新は無効。leaseは5分で、isolate終了や応答損失から次tick以降に回収できる。
6. 既存senderのnotification-event claimとLINEの安定retry keyを最終的な重複防止とする。送信済みnotificationイベントのtriggerも仕事をdoneにするため、送信成功後にWorkerが停止しても履歴から再送候補を作らない。旧Workerへrollbackした場合も同じsent記録を使う。
7. failed/skippedはともに5分後に再確認する。due順を進めるので失敗した先頭が後続を塞がない。通常通知の5分粒度とJST 21:00–08:00の静穏時間、72時間の送信対象窓を維持する。送信結果不明の場合は既存senderの15分ガードを維持し、その後の5分tick（テストでは20分後）で同じretry keyを再利用する。24時間を超える不明結果の扱いも既存仕様のまま。

期限処理の規則を変えていない。Myna/緊急intakeのEXPIRED materializationは既存のaccount-scoped repository呼出しで行われ、その遷移をtriggerが拾う。今回、新たな全account expiry sweepは追加していない。repositoryが呼ばれない未materialize状態までcronで期限切れにする必要があるかは別の機能要件として残る。

## polling・cache・代案の比較

| 案 | D1読取り | 書込み・CPU・追加費用 | 遅延・確実性・複雑さ | 判断 |
|---|---|---|---|---|
| 時刻/partial索引だけ | 全履歴走査を抑えるが、72時間内のsent履歴を反復 | index維持、移行時構築。新サービス不要 | 実装は小さい。未送信が多い場合は既存のLIMIT先頭滞留が残る | outboundと移行backfillに採用 |
| D1 triggerによる仕事登録＋due polling | 過去のdone履歴に比例した反復検索をなくす | 登録1行、claim1行、結果1行程度＋partial index更新。毎tick空の範囲検索は残る | 正常時0–5分。sourceと原子的でイベント取りこぼしを避ける。batch/lease/移行の検証が必要 | status通知に採用 |
| アプリ変更時だけ直接送信 | 空tickの検索を減らせる | 通知API内に外部通信が増える | 全transition siteの網羅、isolate停止・静穏時間・障害時retryの耐久性を別途必要とする。DB triggerだけでは外部送信できない | durable workの補助wake-upなら将来候補 |
| Cloudflare Queue | 大半のpollingを外せる可能性 | Queue message/consume費用、binding・設定、DBとのoutbox同期、dead-letter運用が追加 | 低遅延。ただし重複配信、遅延通知、outbox取りこぼしを設計する必要 | 新サービス/設定の権限が必要。本作業では導入せず |
| Durable Object alarm | 最も近い期限だけwake-up可能 | DO保存・alarm・CPU費用、account shardingとDB同期 | polling減少の余地。alarm再設定と障害復旧が複雑 | 提案に留める |
| tick間のeligibility/credential cache | 同じaccountを反復参照する費用を減らせる | 無効化イベント・版管理が必要 | 退会、停止、権限・秘密値更新の反映が遅れる危険 | 未導入。毎通知の最新確認を維持 |
| invocation内batch・限定cache | round trip/CPU重複を減らせる | 保存サービス不要 | 長い処理中の資格情報・eligibility変更にも注意が必要 | claim/完了batchを採用。新たな資格情報cacheは追加せず |

pollingを完全には止めない。未来の仕事、静穏時間解除、障害・lease回収を既存cronで確実に起動するため、現構成で空の索引範囲検索を残す方が単純。理論的/料金上の「最小」とは断定しない。

## 負荷予算と実測

再現: repository rootで `python packages/db/test/fixtures/cron-scan-benchmark.py`。
入力は全てローカル合成データ。比較前のSQL/schemaは調査SHAからlocal `git show`で読む。
実コードのSQLを抽出してSQLite `EXPLAIN QUERY PLAN`とprogress handler（VM命令を1命令刻みで数える）で計測する。実際のsent履歴、payload、messages_logも作る。

前提: account 1、各domainの履歴H、直近sent H/10、paused claim 1。通常はstatus通知各10件、outbound期限5件、test replay5件。burstはstatus各200件。idleはdue 0。futureはstatus各200件を翌日に置く。
候補検索・既存expiryの7文（accepted、broadcast、unsent2、expiry、status2）に、変更後は仕事のexpiry範囲UPDATEが2文追加され、対象合計7→9文となる。以下の変更後VMはこの2文も含む。アプリの全scheduled文数ではない。
新通知processorの日中idleは各種1 expiry範囲UPDATE＋1 SELECT、変更行0、外部送信0。expiryはpending専用索引を使い、静穏時間には実行しない。候補があるtickはこの2文＋1 claim batch＋1 finish batch（内部では最大50個ずつの条件付きUPDATE）と既存の送信context/認可処理になる。

合成fixtureでの目標予算はidle <2,000 VM命令、通常各10件 <5,000、burstの各50件取得 <15,000。値は実運用SLO/料金予算ではなく、全履歴比例の再発を検出するローカル指標。

| 状態 | H/domain | status due/種 | 変更前7文 VM | 変更後9文 VM | 変更後取得 |
|---|---:|---:|---:|---:|---|
| 通常 | 1,000 | 10 | 69,635 | 3,407 | status各10、replay5 |
| 通常 | 10,000 | 10 | 664,535 | 3,407 | 同じ |
| 通常 | 50,000 | 10 | 3,308,535 | 3,407 | 同じ |
| idle | 50,000 | 0 | 3,305,929 | 1,323 | 0 |
| burst | 50,000 | 200 | 3,329,205 | 8,638 | status各50、replay5 |
| future | 50,000 | 0（翌日各200） | 3,328,809 | 1,538 | status 0、replay5 |

50,000履歴・通常時の内訳（前→後）: expiry 150,483→595、broadcast 150,436→253、accepted 1,900,169→275、unsent retire 150,141→181、unsent resume 200,323→344、Myna 270,404→288、緊急status 486,579→1,385。
通常50,000履歴で追加expiry範囲UPDATEはMyna43、緊急43 VM命令・変更行0。成功通知のcontext読取り・暗号復号・LINE呼出し、queue write/trigger/index更新の命令量はこの表に含めない。過去のdone履歴と未来の仕事を増やしても対象の範囲検索が全履歴走査にならないことを確認した。B-treeの深さ・ページI/Oまで一定という意味ではない。
future caseでは従来のlookback条件が未来timestampも選んでいたが、新構造はdue以前に選ばない。通常/burstの候補IDと件数はdigestで一致確認している。

通知1件の追加費用目安はqueue INSERT＋claim UPDATE＋done UPDATE。sent triggerでdoneになった後のfinishはCASで変更0。failed/skippedではclaim＋rescheduleの2更新/tick。indexもrows_written/保存量に影響するためD1料金の削減率は未確定。
正常時外部呼出しは通知/再試行の必要件数に比例し、idleは対象通知の外部呼出し0。200件burstは各50/tickの上限なら少なくとも4 tickが必要。未処理件数が日中の容量（概算7,800件/種/日）を超える状況では72時間窓から漏れるリスクを監視し、実測を基にbatchサイズ/consumer構成を判断する。
障害回復・paused/credential欠落等は毎5分再確認し、解除に追加のcache遅延を作らない。送信結果不明時は前述の既存senderガードを適用する。

追加の書込み計測（履歴10,000、Myna20件、失敗後に成功）では、状態変更・既存sender処理を含む論理更新数は100→200、SQL文数100→180、VM命令7,410→19,334となった。内訳は仕事登録、claim、失敗reschedule、再claim、sent trigger完了の追加である。queue更新のbatchはWorkerでround tripをまとめるが、SQLite計測のtransaction回数をD1課金と同一視しない。外部HTTP、認証・資格情報取得やCPUはこの追加計測にも含めていない。
200件のMyna backlogは5回の呼出しで[50,50,50,50,0]件を取得し、200件すべてを重複なく完了した。候補検索のVM命令は変更前[59,594,59,529,59,479,59,429,58,829]、変更後[1,125,1,094,1,094,1,094,44]。履歴読取りを減らす一方、イベント発生時の管理書込みが増える点を明示する。

詳細の実行計画・SQLite version・件数・更新数は `evidence/d1-cron/synthetic-results.json`。

## 再同期・互換性・適用順序

- triggerとsource変更は同一D1 transaction。アプリがenqueue RPCを落とす問題を作らない。静穏時間の間も仕事登録は行う。
- migration末尾の2つの`INSERT OR IGNORE ... SELECT`は最近72時間の未sentだけをbackfillする。新索引で範囲を絞り、旧sent通知・他accountの同一retry keyを正しく区別する。これが一度だけ発生する再同期負荷となる。
- metadata修復が必要な場合は031末尾のbackfill2文と、Myna最新時刻・sent/orphan/non-EXPIREDを整合させるUPDATE3文を使う。通常cronには入れない。backfill再実行は既存claim/due/attempt/stateを上書きしない。metadata消失から復元する場合も既存sentレコードと安定retry keyが再送を防ぐ。source登録が原子的なため、毎tickの全履歴再同期は不要。trigger欠落や過去の部分適用など運用上の破損はこの明示的復旧の対象となる。
- 過去migrationは不変更。bootstrap/metaはgeneratorで再生成。既存APIや通知テンプレートは変更しない。旧Workerが新DBに書いた遷移・sent結果もtriggerで追跡される。
- 本番は親/人間が現在のmigration ledger・checksum・schemaを確認してから、既存029までの状態に030→031を正式なmigration engineで適用し、その後Workerを更新する。新Workerが031なしで動くことはサポートしない。Admin/LIFF同時更新は不要。
- 030/031はCREATE IF NOT EXISTSで途中適用からの再開が可能。ただし同名で誤った定義のobjectを自動修正するものではない。正式engineのSQL＋ledger原子適用、checksum照合とschema確認を前提とする。
- 030のindex構築は対象tableを読む。031のbackfill/queue INSERTも一度の読取り・書込みがある。行数・D1余裕・ロック/CPU時間を人間が確認して適用枠を選ぶ。本番でschema再作成・データ削除をしない。
- migration後・Worker前は旧cronが従来の通知を継続し、sent triggerが仕事をdoneにする。Worker rollbackは旧版へ戻し、追加schemaは残す。down migration/dropは不要。
- 適用後はDB別`rows_read`/`rows_written`、cron CPU/実時間、due oldest age、pending/failed件数、通知成功・lease回収、通常の0–5分、失敗時の5分再確認、結果不明時の既存15分ガード後の回収を確認する。今回これらを本番から取得していない。

## 検証と残る限界

- `EXPLAIN` regressionテストは実コードSQLを使い、expiry/replay/unsent subset、paused claim起点、due partial index、通知のsort不要を確認。
- 合成SQLiteでaccount隔離、同時cronの1回claim/送信、古いtoken完了の拒否、5分lease境界、バッチclaim、失敗headの後続到達、5分再試行、送信済trigger、source transaction rollback、72時間境界を確認。
- 既存SQLite通知テストはfailedと他accountのsentが抑止しないこと・LIMITの後続到達・同時tickを確認。JST 08:00/21:00境界テストを追加。既存sender/reply再調整の障害/重複テストも実行。
- DB全体: 105 files / 514 tests成功。031の全statement prefixから再実行し、backfill重複・claim上書き・sent/orphanの取りこぼしがないことを確認。migration期待値を更新し、旧fixtureの単純semicolon分割は既存のtrigger対応splitterへ変更した。
- Worker全体: 276 files / 3,097 tests成功。管理画面の42テストも含め除外なし。以前timeoutしたテストは合成credentialに対するprofile取得のfetch stub欠落を修正し、assigned accountのcredential取得とfetchの1回実行を追加検証した。時刻やtimeoutの緩和では解決していない。
- 更新エンジン全体: 24 files / 230 tests成功。030/031のmanifest更新に加え、schemaとledgerの原子rollback、commit後応答喪失の復旧、適用済checksum不一致の拒否を実engineで確認。
- 実sender＋合成LINE stubの障害試験: 外部受付後ack保存前失敗、ack commit後応答喪失、sent後finish失敗、旧Worker相当との並行送信、期限切れclaimとMyna状態変更を確認。同じretry keyの外部受付は1回、古いfinishでdoneをpendingに戻さない。
- Web 55 files / 267 tests、LIFF 28 / 205、インストーラ12 / 80、LINE SDK 2 / 8、MCP server 8 / 36、SDK 13 / 56はすべて成功。ルートscripts 25 / 263も全成功。合計548 files / 4,756 tests（全test scriptの範囲、関連テストの追加再実行は重複加算しない）。
- Worker・DB・更新エンジンの型検査、変更TSのformat/lint（既存箇所のwarning/infoは残るがerrorなし）、`git diff --check`、30個のpost-baseline migration安全検査は成功。
- 独立レビューで再試行間隔の後退、prefix再開、削除triggerの検索範囲、sent/orphan修復、Myna状態再確認を指摘され、修正後に再レビュー・関連テストを実施。修正後に新たな重大blockerの指摘はなかった。全瞬間の競合を解消した保証ではなく、次の残存事項を伴う。
- `pnpm`の自動依存インストールが環境のホームディレクトリ作成で失敗したため、各packageは既設の`node_modules/.bin`を使用。ルートscripts内のpnpm呼出しはコマンド限定の`pnpm_config_verify_deps_before_run=warn`で自動installを避けて再実行し、263テスト成功。初回の8失敗はこの環境依存のauto-installエラー。依存関係の追加取得/永続設定変更は行っていない。
- D1実ランタイム、remote query plan、実DBの分布/統計、CPU課金・Queue料金は未検証。ローカルSQLiteのVM削減をD1の`rows_read`削減率に置き換えない。
- done/expired workは2つのpending索引から外れるが、metadata本体は増える。今回、削除/保持期間変更は導入していない。保持方針と容量は別途レビューが必要。
- accepted repairは全accepted履歴を読まないが、長期間pausedの未解決claim自体が大量にある場合はそのpending集合に比例する。期限retireは全due openを一括更新する既存仕様を維持し、大量due burstのCPU/書込み上限は未実測。
- 新たなtick間cacheは追加しない。資格情報、account停止、capability、patient preferenceは既存senderの送信直前確認を維持する。

- 送信前にsource状態と現在claim/leaseを再確認するが、その最後の読取りと外部送信の間に取消が入る競合窓は残る。外部APIとD1の原子commitはできず、任意の瞬間の取消と送信の排他を保証していない。結果不明が24時間を超えた場合の手動照合も既存運用に従う。


## 最終追加比較（調査SHAと現在差分）

| 懸念 | 変更前 | 変更後・判定 |
|---|---|---|
| 取消と外部送信の競合 | Myna sweepの読取り後に状態が変わっても旧recipient検索はhandoff状態を再照合しなかった。外部LINEとDBの原子処理もなかった | 新Myna senderは現在状態・source/account/friendとclaim/leaseを再照合し、競合窓を狭めた。最終読取りから外部送信までの窓は既存由来で残る。緊急通知は最新状態そのものではなくimmutable遷移ごとの通知という既存契約を維持する |
| 完了metadataの蓄積 | source履歴、既存通知のidempotency記録、緊急immutable event履歴は残っていた。専用work tableはなかった | 専用workのdone/expired行と索引保存量は**新規コスト**。既存の再送記録は削除せず、partial索引で日常検索から完了履歴を外す。今回、保持方針・削除・課金設定を変更していない。蓄積自体による新規の通知除外はない |
| 72時間のbacklog窓 | source.updated_at（Myna）/event.occurred_at（緊急）から72時間、各50件/tick。日中容量超過・長期障害で通知対象から外れるリスクは既存 | 同じ窓・境界・上限を維持する。下記2点は今回のqueue化に伴う新規リスクとして発見・修正した。日中容量/長期障害による元の制約は残る |

1. **期限切れ仕事によるLIMIT占有を修正**。旧SQLはlookbackより古い履歴を候補から除外したが、最初のqueue実装はexpired pendingを50件枠内で処理し、後続のlive仕事を遅らせる可能性があった。現在はpartial expiry索引で`expires_at < now AND due_at <= now`を先にexpiredへ移す。72時間ぴったりと有効なleaseを維持し、古いfinishでpendingに戻せない。Mynaの101件stale＋境界1件、両kindのleaseテストに加え、合成データでは各種200件staleを処理し、その同じtickでlive各1件を旧実装と同じIDで取得した。対象仕事以外・source本体の削除はない。大量期限切れの一括更新負荷は実D1で未計測。
2. **Mynaの更新時刻による窓の再開を修正**。`recordMynaVerification`はPRESCRIPTION_EXPIREDの職員確認で既にEXPIREDの行にも最新updated_atを保存しうる。旧SQLではそこから72時間だったが、最初のtriggerは状態遷移だけを拾っていた。現在は同じEXPIRED状態のupdated_at更新も拾い、未送信workのexpiresを同期する。doneは再開せず、現claim/lease・attemptは維持する。expires CASで古い候補のclaimを拒否する。trigger未適用中にupdated_atだけ進んだ部分移行も031末尾の修復UPDATEで整合させ、未変更expiredは復活させない。実SQLiteのprefix/再実行テストと独立レビューで確認済み。

追加修正後にWorker全体3,097、DB全体514、更新エンジン230テストと関連型検査を再実行し成功。変更のない他suiteの前回成功結果と合わせ全4,756テスト。新expiry/refresh/repairを含む独立再レビューでも重大な未修正事項は指摘されなかった。

全変更patchには追跡済み差分と全新規ファイルを含める。元SHAのclean local checkoutに`git apply --check`後に適用し、作業環境の変更ファイル全件をbytes/SHA-256で照合する。patchとファイルの保存manifestは`/tmp/pharmacy-d1-cron-review-manifest.json`、patchは`/tmp/pharmacy-d1-cron-review.patch`。元作業環境のHEADを変更せず、commit/push/PR/本番操作は行わない。
