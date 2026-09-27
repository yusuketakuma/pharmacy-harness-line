# MCP残りtool受入記録

ID AUDIT-MCP-REMAINDER-20260922、担当 /root/audit_db、read-only。
開始HEAD376e4a0f818ca80a1a5333a8d05f82c26b5531e3→終了72fdd2671be45ea95cb3e94b078854fca6a3281f。差分は親broadcast.ts/testのみ、新finding対象は不変。変更/commit/patchなし。
保持: server scope認可、tool公開契約、結果不明時データ保全、薬局richmenu確認。
実施: cat/sed/rg/git rev-parse/git diff name-onlyのみ。forms route検索不在1件は未確認。編集/test/API/secret/spawnなし。

## F-MCP-04 P2 CONFIRMED_BUG

create-scenario.ts101–120のstep作成例外catchがscenarioをdelete。最終step保存後の応答喪失でも完成scenarioを消す。Worker scenarioDELETE310→DBscenarios253の実削除。DBcreateはis_active=1、組立中からactive。cleanupエラーは握潰し、ID/保存済step範囲を返さない。実LINE送信/enrollment消失は未再現。
修復候補: IDを残して結果照合。inactive組立を採択するならservercreateはINSERT後別UPDATEでinactiveなのでそのままでは公開期間ゼロを保証しない。親はcreate-scenario/SDKscenario/DBcreate/delete/Workercreate/delete原典を照合済み。DBcreateはline_account_idも別UPDATEなので組立前のscope窓を同時に確認する必要。

## C-MCP-05 P3 concern

create_form schemaにaccountId/default説明あり、handler/SDKinputが無視。SDKFormsにdefaultaccount処理なし。formがtenant共通かaccount単位か未確認、越境は断定しない。

## 全登録wrapper coverage

REVIEWED（静的、consumer全体を意味しない）:
send-message, create-scenario, enroll-scenario, manage-tags, create-form,
create-tracked-link, create-rich-menu, list-friends, get-friend-detail,
get-form-submissions, get-link-clicks, account-summary, list-crm-objects,
manage-ad-platforms, get-conversion-logs, manage-staff, upload-image,
manage-friends, manage-scenarios, manage-broadcasts, manage-rich-menus,
manage-forms, manage-tracked-links, manage-auto-replies, manage-traffic-pools,
manage-message-templates, list-conversations, get-conversation,
custom/pharmacy/rich-menu/tools。
broadcastは親F09変更後独立確認待ち。その他既読wrapperは対象差分不変で前回記録再利用。

主な確認: enroll IDs転送、tags action別逐次batch（途中成功分はerror出力なし）、trackedlink URL/account転送、richmenu固定account/dryrun/confirm/multipleroutes、friends filter/metadata、detail messages fetch、formsubmissions/linkclicks SDK、summary account列挙/固定path/warnings、CRM enumdispatch scope引数相違、adplatform config/testsend、conversion limit、staff credential発行なし、upload base64、friends assignment、scenario step条件、broadcast draft予約拒否、forms fieldsJSON、autoreplies nullableaccount、traffic/template encoded IDs、conversation pagination。

登録一覧/client/api-call/resources/richmenu guardは前回再利用。追加周辺: SDK forms、DBscenario create/delete、Workerscenario create/delete。
URLはpayloadとしてAPIへ、MCPから任意URL fetchなし（読取範囲）。shell/eval/動的コード実行なし。get_friend_detail/SDK多数にID未encode path連結あり、権限回避/外部origin到達未確認。numeric limitの説明上限をZod強制しない箇所あり、serverlimit未確認。account引数はフィルタで認可はserver依存。

未確認: 全server認可/URLvalidation/PHIerror、hostapproval、全consumer/副作用atomicity。MCP protocolは子未実施、親F09別証拠のみ。全wrapper読取りを認可全体PASSとしない。
