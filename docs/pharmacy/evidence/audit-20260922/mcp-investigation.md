# MCP限定調査受入記録

ID AUDIT-MCP-20260922、担当 /root/audit_db（再利用read-only）。P/W=a96aa8158a88f296237e068c5f8ba67ab3abb1a2、開始終了HEAD一致。変更/commit/patchなし。X06/C05/C06/C07はPARTIAL。
保持契約: server tenant/account認可、担当者manual header、薬局rich-menu account固定+確認、結果不明時のデータ保全、public tool名/input/output互換。
実施は限定git/rg/cat/sed/head。読取り成功、切断出力はPARTIAL。起動/API/test/編集/secret/実データ/spawnなし。

## F-MCP-01 P2 CONFIRMED_BUG

tools/broadcast.tsはsegment送信例外で作成broadcastを無条件delete。Worker broadcasts.ts854–914はstatus=sending/条件/offsetをcommit後202を返す。応答喪失/timeout時はqueue登録済みでもMCP catchへ進む。DELETE568–585は所有確認のみ、状態guardなし。db/broadcasts197–199のID削除でgetQueuedBroadcastsのsending列挙対象と記録を失う。送信後結果不明は未送信ではない。実患者/外部送信・部分配信は検証なし。generic薬局gate到達は未調査。親は該当toolとWorker送信/削除を直接照合済み。
修復候補: send開始後deleteを避けbroadcast ID/結果不明を返し状態照合可能にする。GET draft→DELETEだけでは競合残存、cleanup必要ならserver条件付きmutationが必要。合成transportでqueuecommit後応答喪失を再現する。

## C-MCP-02 P2 concern

多くのSDK toolがString(error)を応答へ返す。SDK httpはnon2xx JSON errorをLineHarnessError.messageへ転載。一方api-callは固定文言化。確認broadcast route500は固定なのでPHI/secret漏洩確定ではない。全SDK route error契約未読。

## O-MCP-03 P3 optional

upload-image catchがJSON success:falseを返すがisError:trueなし。具体的障害/必須契約未確認、未採択。

## 確認境界とcoverage

stdio入口・tool登録/client/api-call/resources、send-message/broadcast/manage-staff/upload-image/manage-friends/manage-forms/manage-tracked-links/get-conversation/manage-message-templates、薬局rich-menu guardは全文静的REVIEWED。
create-scenarioはstep事前解析→create→rollbackのみPARTIAL。manage-ad-platforms/薬局richmenu toolsは切断箇所未読。SDK http/broadcast/friendsとWorker send-segment/delete/DB delete/queueは当該経路のみREVIEWED。その他登録tool未読。
固定登録とJSON text応答、読んだ範囲にeval/shell/dynamic importへtool出力を渡す処理なし。ホストagentのprompt injection反応・承認設定は未検証。
getClientはenv URL/key/tenant必須、tool入力tenant上書きなし。accountId引数だけを権限扱いとは断定しない（Worker最終認可未確認）。richmenuはenv account固定とmutation confirm。friends.sendMessageはmanual header。generic即時send/broadcastはtool説明に即時送信明記、MCP内confirm不在だけで違反としない。Zod型/enumとaction別手動必須検証、JSON業務validationはserver依存。

未完: F-MCP-01合成再現修復、generic gate、SDK error追加調査。全tool認可/PHI保護PASSではない。
