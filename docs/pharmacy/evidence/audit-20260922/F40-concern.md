# F40候補 — emergency retentionの削除保留日時判定

EVIDENCE_BASED_CONCERN/P2。F39後のcaller再探索、製品コード未変更。独自ACTIVE_LEGAL_HOLDはrelease_atのNULL/文字列大小のみ。共通ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQLはcanonical実暦日/状態も確認。
F40-hold-probe.mjs/json: 実ソース述語をnative D1で評価。legal_hold=1/status=legal_hold_assessed/scope一致で、2020-02-30、24時、JSToffsetはemergencyBlocked=0/sharedBlocked=1。正常過去leapdayは双方0、NULLは双方1。exit0/外向通信0。
この差だけで全emergency policyの欠陥を断定しない。次に承認仕様/DSR状態契約と該当callerを照合し、合成full redactionで不明な保留解除日時を持つ相談がredactされるか再現する。F39は長さ制限修復であり、本件を解決済みとしない。実データ/本番影響未確認。
