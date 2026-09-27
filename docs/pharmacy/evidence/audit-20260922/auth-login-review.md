# 管理者ログイン・パスワード変更の限定監査

P=W=6751d6edcb164dd8e4ac59fc53824a438bfac13d、primary、READ-ONLY。前auth-investigation.mdの未読login/password-changeを追加確認。全体認証をREVIEWEDとはしない。source変更/patch/commit非該当、証拠のみ。

読取: admin-auth.ts1–417全文（login/change-password）、credentials77行/auth-throttle100行/auth-policy/common-passwords/crypto-utils全文、ADMIN-AUTH.md1–125。既存auth-investigationのmiddleware全文とlogout/session部分は旧snapshot72fdd267→現HEADで該当source差分なしを確認して再利用、opaque-session196–281は再読。rate-limit/indexは登録順とloginのIP-key分岐のみ。生成common-password corpus自体は未読、外部取得なし。
保存経路: custom_071 migration251–319（session作成authority、identity不変、復活禁止、credential更新revocation）、custom_063 1–80（tenant/staff/membership停止とsessioninsert guard）を確認。schema全体/migration全体をこの読取だけで監査完了にしない。

確認: loginは厳密admin Origin判定→body型/旧apiKey・loginId拒否→NFKC pharmacyCode lookup、active tenant/shared principal/admin membership/credential enabledを要求。password照合前に永続throttle claim、unknown codeには固定ダミーhashで照合。失敗audit永続化不可は503、パスワード値をlogやJSONへ渡さない。成功batchはthrottle clear/session insert/auditを一組にし、sessioninsert triggerが現在credential versionとactiveauthorityを再確認する。SELECT後のcredential disable/rotationに対し、古いsessionを無条件INSERTできるという仮説はこのguardで反証される。Cookieはopaque token、DBはhash、tenant bindingとcredential versionをmiddlewareが再確認。
password-changeはpassword session+token+credential version/current password+新passwordpolicyを要求。UPDATEのCASはtenant/staff/version/enabled/現在tenant/membership/sharedstaff/sessionrevocation+absoluteexpiryを条件とし、直後audit INSERTのchanges()=1/NOT NULLで0更新時にbatchrollback。credential version更新triggerで旧sessionsをrevokeし、Cookieを失効。無条件のDB全体更新や元secret値の出力は確認しなかった。
credentialsは既存PBKDF2-SHA256/100k・16B salt・32B hash、15–128 Unicode codepoint・ローカルcommon corpus、32B random opaque tokens、fixed-length byte compare。暗号パラメータを新規推奨/変更する監査ではない。hash parserは100k–1m iterationsを許容するが実Worker上の全range互換までは未確認。schema自体のマルウェア耐性等を主張しない。

テスト照合: credentials.test60行/throttle.test9行、admin-auth.test1–100/388–415/463–501/559–658を実読。route testのD1はSQL文字列に応じるMap mockであり、名前にD1とあってもnativeD1ではない。一方db/test/010_custom_067全文は実better-sqlite3でactual claimLoginAttemptを呼び、5回目固定lock/blockedattempt非延長/907秒で解放/normalize/clearを検証。custom_015 test全文は実SQLite/bootstrapでtenantcredential/sessionFK+authorityを確認。F29統合ログのauth16、credential5、throttle1、DB throttle2/credential4 PASSを、対象source/test不変のため再利用し反復しない。全routeのactualD1結合/失効競合をこの結果から成功扱いしない。

残項目: auth-investigationのlast_seen更新競合/失効と開始済requestの意味は未解決（新しい確定findingなし）。read→mutationの全authorities線形化、password-change batchのnativeD1障害競合、platform login/人のAPIkey発行回転全経路、全publicallowlist/tenant-boundaryは別範囲。次はこの既存懸念を限定再現するか、未読tenant-boundaryを追う。外部送信/実password/実session/本番データにはアクセスしていない。

検証コマンド: cat/sed/rg/wc、git diff old HEAD --stat（対象差分なし）、Python source SHA256。初回のcredential globはzsh no-matchで失敗し、rg --filesで実pathを解決した。truncated出力のauth部分は196–281を再読。独立review非該当（primary調査）、fresh最終reviewの代替ではない。
