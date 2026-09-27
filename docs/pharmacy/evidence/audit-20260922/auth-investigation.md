# 認証限定静的監査受入記録

ID AUTH-STATIC-20260922-01、担当 /root/audit_db、read-only。記録snapshot72fdd2671be45ea95cb3e94b078854fca6a3281f。親F10変更対象は認証と重ならず、auth.ts/admin-auth.ts/staff.tsのsnapshot差分なしを子確認。変更/commit/patchなし。
実施: git/cat/sed/rgのみ。推測path不存在は実在pathに訂正。test/typecheck/起動/API/実データ/並行再現/secretなし。

## Coverage

- middleware/auth.ts 全563行: 公開method/path、Cookie/Bearer選択、membership、CSRF、bootstrap制限、identity、next。
- db/staff.ts1–135: API key HMAC/plaintext dual-read、active、backfill。
- admin-auth-config.ts: cookie/CORS origin正規化、admin/LIFF origin分離。
- provisioning/auth-policy.ts全文: bootstrap absolute30m/idle10m、standard8h/15m。
- routes/admin/admin-auth.ts418–595: session一覧/revoke-others/logout/session応答。login/password-change全文未読。
- services/liff-auth.ts全文: 未検証audは検索selectorのみ、LINEverify成功がauthority。
- prescriptions/patient.ts全文: verifiedidentity/liffId/account/tenant/friend複合照合。
- intake/continuity/medication-followup routesは患者gateと直後collectionのみ。
- growth-loop/access.ts1–185: DBprincipal/membership/accountassignment再確認。
- index240–280登録順。ADMIN-AUTH.mdは出力省略部分未精読。platform-admin authは親既読を再利用。

保持確認: X-Tenant-Idはselector、APIkey/envownerもactive membership必要・role採用。opaque sessionはtokenhash/credentialversion/activecredential+tenant+staff+adminmembership/absolute+idle expiry/tenantcookie照合。変更操作CSRFheadercookie一致、Bearer失敗時Cookiefallbackなし。bootstrapはpasswordchange/sessionへ制限。LIFFauthbypassはroute本人確認へ委譲、確認3domainでverifiedidentity/patientscope。shared principal種別はgrowthaccessでDB再照合、転記欠如だけで拡大と断定しない。

## Concern A: session失効競合

auth227–266 SELECT後にlogout(admin-auth540–551)/revoke-others487以降がrevokeするとlast_seenUPDATE270–275は0件だがidentity返却。コード成立高、期待契約違反未確定。開始時有効request完了を許す契約なら即欠陥としない。UPDATEを認証確定点にする場合は0件拒否/credentialmembership再確認が必要だが、後続mutationまで線形化する保証ではない。

## Concern B: last_seen並行後退

auth223–224の古い時刻で272UPDATEが遅れると新last_seenを上書きし早期idle logoutの可能性。低重大度、実害未測定。単調更新で防止可能、未再現。

## 除外

indexの/* collection不一致コメントからのgate不足疑いは除外。installed Hono reg-exp-router/node.js5はTAIL_WILDCARD_REG_EXP_STR=(?:|/.*)。intake routes test343–349にcollection無認証401/repository未呼出既存テスト（子は未実行）。コメントだけで欠陥判定しない。

未確認: 全publicallowlist route本体、tenant-boundary全体、login/passwordchange/APIkey発行回転の全経路、legacykey fallback意図。認証迂回の新規確定なし。全authPASSとは扱わない。
