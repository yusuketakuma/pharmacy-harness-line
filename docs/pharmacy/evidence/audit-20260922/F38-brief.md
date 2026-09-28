# F38 FIX — 保存判定の日時検証を正確かつD1互換にする
CONFIRMED_BUG/P2、P=3158e7c337a3d43022b1db6fd0a4ce0fc4877257、primary/dev。書込予定: legal-hold.ts/test、retention/fence.ts、db/test/retention-d1.test.ts、必要な既存consumer回帰。
根拠: retention-date-probe.json。JSが2020-02-30/24:00を正規化してreleased。native D1は既存shared SQLのGLOBが50byte pattern制限に抵触し有効日でも例外。RETENTION_MATRIX.mdのmalformed=unknown/保持契約に反する。実削除・本番被害は未確認。
保持: 既存API/SQL predicate export/now bind数・順/33source/認可/状態/schema/期間/有効閏日の3年加算意味。意図的差分: 不正暦日をunknownへ、正規日時SQLをnativeで評価可能へ。
方針: JSは既存shape/finiteの後にISO roundtrip一致、SQLはlength24+strftime正規化一致(+0 seconds)で同canonicalUTCを検証。新export/helper/dependencyなし。
検証: 旧Pのunit/native失敗、各invalid/valid/boundary/null/hold0/active状態をnative predicate、実source/activeDSR consumer回帰、型/必須verify/compiled runtime。適用済migration・実データ変更なし。限定review・isolatedpatch/hashまで。
