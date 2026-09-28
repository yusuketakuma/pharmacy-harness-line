# Operator管理の限定境界確認

P=044e817d2685edad303bc1fe0708200855c0e3a8、primary read-only、product変更なし。
対象: index.ts登録240–290、generic-feature-guard.ts allowlist/prefix/guard、auth.ts authenticateRequest/ApiToken、role-guard.ts、chats.ts operators CRUD、packages/db/src/chats.ts1–100、schema operators定義とmigrationへのoperator探索。

薬局では /api/operators はallowlist外かつdisabled generic prefix。auth→tenant allowlist→generic guard→route順なので、認証済薬局tenantから通常operators CRUDへ到達する仮説は静的に反証。platform-admin tenant設定tokenもauth側のsettings path制限があり、operatorsを包括許可する経路ではない。全middleware runtimeの再検証ではない。

汎用operatorはname/email/roleのglobal tableでtenant/account列なし、APIもget/update/deleteのtenant predicateなし、role guardなし。一方薬局staff_members/tenant membershipsとは別モデル。汎用複数tenantでの帰属・全体管理者のみ操作という仕様根拠は今回未確定。EVIDENCE_BASED_CONCERNとして残し、推測で共有資産へtenant移行/割当を実装しない。

既存generic-feature-guard.test.tsはoperatorsがdisabled listに含まれることを検査、個別operators fullapp動作をこのtestから主張しない。製品無変更のためF32全体verifyを再利用。独自DB/API実行は未実施、commit/patchなし。全汎用CRUD/認可はPARTIAL。
