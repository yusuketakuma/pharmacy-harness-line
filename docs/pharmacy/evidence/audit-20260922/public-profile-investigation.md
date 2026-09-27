# PUBLIC-PROFILE-20260922-01

担当/root/audit_db、開始終了HEAD af9a0822ef17f2f57557512c6fafabd0ea977b70。root/worker/liff AGENTS適用、read-only。変更/patch/commit/外部操作なし。

確認: LIFF App /pharmacy/info→PharmacyPage→pharmacy_info capability→public-profile/PharmacyInfoPage.tsxとapi.ts/request.ts。画面全文はReact text、HTML挿入なし、tel文字と地図/website URL検査。固定API/LIFF ID query/IDtoken Bearer、patient/account IDのAPI引数なし。Worker public-profile/routes.ts/repository.ts全文、account.ts全文、index mount/account guard、baseline対象table、対象routes/repository/api/画面の4tests全文。auth.ts/liff-auth.ts/prescriptions/patient.tsは同一コード前回既読を再利用。

LINE認証→active account/tenant/login channel/liffId/subject/friend解決→account bind SELECT→明示公開projection。返却18field: display_name, phone, fax_number, postal_code, address, business_hours, closure_notice, access_note, parking_note, google_maps_url, prescription_reception_hours, after_hours_note, services_note, accessibility_note, supported_languages, payment_methods, website_url, updated_at。updated_by/created_atはSELECTになく、line_account_idは患者projectionから除外。DBrowのspreadなし。

管理PUT owner/adminのみ、保存先accountとstaff IDはcontext、body account IDをauthorityとしない。staff GETのみ。OPERATION_GUIDE93の編集権限と一致。既存testsは別account selectorでもauthorized account、staff PUT403、匿名401、患者応答exact equality、URL/電話/長さ拒否、画面account ID無し/危険URL無しを検査。今回test実行なし（前回統合結果とは区別）。

懸念1: COALESCE(profile.display_name,account.name)、未設定でもaccount存在なら200。account.nameを内部専用とする契約は未確認、公開漏えい確定としない。
懸念2: BETA_PARTICIPATION47のnone/public always availableとLINE認証/friend404/capability制約。beta gate不要の文脈なら両立、匿名公開を意味するか未確定。認証を削除しない。

実施: git rev-parse、対象cat/sed/rg、対象directory git diff（差分なし）。test/build/typecheck/browser/実DB/LINE/公開実値は子未実施。直接依存以外の全auth/capability PASSを主張しない。確定越境/非公開field漏えいは今回の範囲に無し。親frontend buildとは別の静的記録。
