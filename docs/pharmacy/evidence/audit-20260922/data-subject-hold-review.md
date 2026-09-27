# Data subject legal hold 限定調査

ID DSH-LR / audit_db。P `55c170b1c4ec61c54ef1a93bffb892f36d08c529`、HEAD一致。既存thread再利用、全feature完了/fresh全体レビューではない。

| path | 読取時SHA256 |
|---|---|
| `apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.ts` | `b39f1df05e4269117d63aaf6f9f7af3c15c9c71802eb18f464c05016a81a3557` |
| `apps/worker/src/custom/pharmacy/data-subject-requests/legal-hold.test.ts` | `19800a45bf996693664576df89a2b4fe84fb2afade8fa23a5da6bfb5c5402375` |
| `apps/worker/src/custom/pharmacy/retention/fence.ts` | `24107221be41407dc1a08a3d530a5d3538db4093378134c403228d5978da5123` |
| `apps/worker/src/custom/pharmacy/retention/deletion-intents.ts` | `e3e42b6e15e085181f31555fd45e674c50b239388dcd9ae51e2914e091204a58` |
| `apps/worker/src/custom/pharmacy/retention/incoming-images.ts` | `46e13a520ecf447772c79583cd579bb1fefaf16713806f2a6d5cb7a4c5fa93ac` |
| `docs/pharmacy/RETENTION_MATRIX.md` | `c1bcc1cebeaf3b8b23fd8652e1b80ccd61d1ef9e11c10f9bc5618edc130d2163` |

## 経路・不変条件

legal-hold.tsはtenant-account active mapping count=1、patient id/account/owner count=1後、patient sourceとowner sourceの全timestampを評価。null/format外/nonfinite/query failureはunknown。owner sourceはpatientに紐付け不能なLINE/ECをowner全患者へ含め、DSR自身はclockに含めない。RETENTION_MATRIX current contractと整合。messages_log/chats/friendsのJSTが含まれると非UTCとしてunknownとなるのは、削除を過剰に止める既知のfail-closed契約であり、今回のバグとして非UTCを勝手に許容しない。

retention/fence.tsのexactとowner inventoryは全患者を評価しunknown優先、どれかheldならheld。active DSR overlayはtenant/account/owner/patient/request type/statusで限定。received/identity_verifiedや不明hold値はunknown、明示hold1はrelease timestampを検証。最終fenceはepoch CASで保存し、削除側はreleased/epochとactive DSRを再チェックする。deletion-intents SQLはtenant/account/owner/(exact patient or *)、incoming側はaccount内R2 owner解決でDSRを限定する。

## Findingと未確定

DSH-01: 日時shapeを満たすが実在しない日時のfail-closedに穴（predicate単体の契約違反を静的確認、重大度は破壊経路の実行成立次第、確度はSQLについて高）。ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQLはlength/GLOB/text<=しか使わない。例 `2020-99-99T00:00:00.000Z` は過去の文字列として扱われ、legal_hold_assessed/hold1がblock対象から外れる。fence overlayのDate.parse finite判定なら拒否するため二重checkの意味が不一致。既にreleased fenceがあり再検証間にこのようなDSR値が入る場合の最終ガード懸念。ただし正常APIからその値を保存できる経路、preflight/digest/epoch等の全防御突破と実R2削除は本担当未確認。『本番削除できるconfirmed exploit』とは主張しない。

DSH-02: JS側もregex+Date.parse finiteだけでISO roundtrip一致を検証しない。存在しない日（例2月30日）がDate実装により翌月へ正規化される場合、unknownではなくheld/releasedへ進む可能性。latestPhiRecordedAt、assessRetention、activeRequestOverlayが同じ不足。実engine合成再現は未実施なので要再現candidate。legalHoldReleaseAtは入力前提の低水準関数で直接invalidはthrowし得るが、assessPatientRetentionのcatchでunknown化する。保存年数/閏日の業務契約を変更する根拠にはしない。

scope反証: 明白なpatient IDだけの漏れやownerを跨ぐ最新source採用は読んだSQLで見つからない。files/eventsはsubmission結合、継続等はaccount一致でparentへjoin。mapping countは指定tenant/accountだけを数えるのでコメントのmultiple mapping全般を証明するものではない。DB制約による一意性/全schemaは今回再監査しておらず、これを確定認可バグとも断定しない。

## 必要な次の有限検証

1. pure assessRetention/latestPhi/overlayを合成2月30日・月99・24時・NULL・date-only・JST・有効Z・境界時刻で確認。期待は契約上malformed=unknown。
2. actualSQLiteでshared predicateを単独評価しinvalid過去年のblockをassert。正規expired/held/hold0/status別も対で保持。
3. 実fence評価後にmalformed DSRへ置換する合成interleaveでdeletion-intent/incoming最終checkを確認。外部R2はstub、実本番操作なし。writerがmalformedを生成できるかは主担当repository調査と統合。

## 読取・未実施・統合注意

legal-hold.ts source inventory/判定全文を分割読取（初回出力truncate箇所は後段を補読）、fence.ts inventory/overlay/prepare関連、deletion-intents/incomingの共有predicate consumer周辺、legal-hold.test.ts既存invalid/null/queryfailure test、RETENTION_MATRIX current contract/削除fail-closed箇所を対象。retention実行全体・repository遷移は未読/親担当。全33sourceと全schema行の網羅照合完了は主張しない。

実施cat/sed/rg、git rev-parse、Python hashlib。出力一部truncateあり、全ファイル読了と誤記しない。独自test/SQL実行/外部/実データ/secret/spawnなし。P/path hash記録のみ、source/Git/commit/patch変更なし。作成物はこの記録。正式期間や法制度の妥当性は調査・変更していない。指摘はrepo既存fail-closed契約との技術的不一致に限定する。
