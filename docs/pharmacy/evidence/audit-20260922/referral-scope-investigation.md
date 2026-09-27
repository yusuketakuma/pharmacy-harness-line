# REFERRAL-SCOPE-20260922-01

P/W=385bd61f1d352c2fceff30bd8e20cbda4a00ab82、primary/read-only。製品変更・新test/外部通信・commit/patchなし。参照本文再読、GitはPLANS/evidenceのみ。

範囲: routes/messaging/entry-routes.ts全体、db/src/entry-routes.ts1–200、liff.ts225–332/834–874/916–970/1367–1416、webhookの前ターン既読referral consumer、immediate-first-step139–185/356–407、friend-tag-attach.ts先頭104、db/scenarios433–490、bootstrap該当scope triggers。検索・一部readを全module完了とはしない。

保存側: CRUDはserver tenantIdをDBへ渡す。bodyからtenant権限を採用しない。entry_routes_resource_scope_insert/updateがtag/scenario/pool/intro_templateのtenant_id IS NEW.tenant_idを必須化し、違反はABORT。routeコードに検証がないことだけで保存越境とは言えない。ref_trackingもfriend accountのmapping tenantとroute tenant一致をtriggerで検査。friend_scenariosもaccount又はtenant整合をINSERT/UPDATEで検査。ただしscenario.tenant_id null/account nullのlegacy共有形式は別扱い。

実行側候補: getEntryRouteByRefCodeはactive refだけでtenant引数なし。liff OAuth/既存linked分岐は任意refをfriends.ref_codeへ先に保存し、その後にref_tracking作成。既存linked分岐はtracking失敗をcatchして処理を続ける。friends.ref_code自体をtenant制限するtriggerは対象bootstrap検索では見つからない。webhook followは保存済ref→route→intro_templateをid単独で読み、イベント側tenant/accountのclientでintroを送る。route.tenant_idとの明示比較なし。scenario/tagには下位制約があるがintro pushの同等防壁は今回読取った経路にはない。

判定: EVIDENCE_BASED_CONCERN（cross-tenant intro送信候補）。実SQLite/HTTP/provider stubで未再現、正当なlegacy null-tenant契約も未確認。薬局webhookはgeneric送信前にreturnし、薬局adminではentry-routes非allowlistで拒否されるため、薬局本番で送信されたと主張しない。generic OSSのaccount/tenant契約は全体監査対象なので未確認として残す。旧ref/null-tenant共有互換を無根拠に廃止しない。

次の有用作業: 既存webhook fixtureでtenant-A friend/refとtenant-B introを用意し、intro lookup/sendが起きるかを検査。bootstrap triggerを有効のまま保存可能なref_codeとrejected ref_trackingを確認し、外部通信をstubする。再現できたら限定FIX packetを採択。保存時triggerの存在を無視した大幅な認可改修は不要。全体Goal/最終独立レビュー未完。

## LIFF downstream 再探索（2026-09-22、F16後）

基準/成果P=W=5daae756c7951d9141d09d7335d66ed6a34e1255、primary/dev、製品コード変更なし。Git開始時は既存の今回用PLANS.md/evidenceのみ。対象: liff.ts58–84/225–335/800–885/916–950/1265–1418、immediate-first-step.ts185–260/290–407、friend-tag-attach.ts全体、db/scenarios433–490、bootstrap3872–3945/5223–5247、liff-pharmacy-oauth-boundary.test.ts全体。既読範囲は再利用。

確認: /api/liff/linkはLINE ID tokenを検証できたlogin channelからaccountを選び、account付きfriend lookupを行う。紹介refの解決はtenant未指定だが、foreign non-null tenantタグのINSERTはfriend_tags_tenant_scope_insertがABORTする。attach helperはINSERTのawait後にのみmileage/scenario/event副作用へ進み、このABORTを握り潰して後続へ進む構造ではない。every-click immediate pushもenrollFriendInScenarioをawaitしてから送信する。friend_scenarios scope triggerがforeign account又はforeign non-null tenantの登録を拒否する。scenario_stepsのtemplate参照にもtenant一致triggerがある。従って、紹介検索がID単独という事実だけではF16のintro直接送信と同じ越境を主張できない。legacy null-tenant/accountの意味と、tracked/affiliateの通知経路は未確定で別途確認が必要。

訂正/明確化: generic-feature-guardのみでは/auth/callbackの保護を説明できないが、liffRoutes自身の/auth/* middlewareがhasPharmacyModeAccount時404を返し、LINE呼出しより前に停止する。/api/liff/linkと/send-form-linkも同じ入口拒否。既存boundary testは5入口を404かつfetch呼出し無しで検証している。薬局導入時にこのlegacy OAuthが通常到達可能とは扱わない。

検証再利用: integration-F16-verify.logにliff-pharmacy-oauth-boundary8tests PASS（1085行）、liff-oauth-scenario-gate18tests PASS（982行）、対応source/configに以降変更なし。今回新規test実行なし。後者のref_trackingはmockなので実DB拒否をそのsuiteの証明としない。DB triggerは今回source照合、F16の実SQLite証拠はref_tracking/friends.ref保存のみで、tag/scenarioの新規DB再現とは区別する。

未確認: generic OAuthはref_tracking ABORTで後続を停止する一方、先行friend.ref更新は残り得る。LIFF linkではtracking例外をcatchしattribution継続する。これらの利用者応答/部分保存、legacy null所有、tracked/affiliate通知境界は未完。全module/coverageをREVIEWEDへ昇格しない。次の作業はaffiliate通知の主体/宛先の決定と保存制約の照合。新しい確定finding/修復packetなし、patch/commit非該当、最終fresh-context独立レビュー未実施。
