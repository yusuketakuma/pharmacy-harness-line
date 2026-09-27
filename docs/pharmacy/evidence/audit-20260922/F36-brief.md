# F36 FIX — 新規DSR受付でhold epochを逆戻りさせない
CONFIRMED_BUG/P2、P=55c170b1c4ec61c54ef1a93bffb892f36d08c529、primary/dev。
範囲: data-subject-requests/repository.ts と db/test/custom_038_pharmacy_data_subject_requests.test.ts。
根拠: F36-red.log、実SQLite/bootstrap・実repositoryで2FAIL14PASS。追加受付で2→1、別請求の受付/本人確認/再判定で3へ戻ると、先行処理の古いreleased判定が新PHIのheld判定を上書きしerasureをresolvedへ進める。実削除や本番被害は未確認。
保持契約: 既存API/引数/schema、request version、本人確認/役割/tenant境界、監査イベント、保存期間/正規日時規約は維持。既存公開hold_epochの世代意味を復元。初回値1、以後scope内MAX+1、exactとwildcardは同じ値。
設計: 新規受付のexact INSERT SELECT内で現在scopeのMAX+1を計算、同batchのwildcardがその世代を再利用。事前read→writeにしない。既存transitionのexpectedHoldEpoch CASは維持。
検証: 初回/反復/owner-wide高世代/別患者/別account・interleave、既存DSR/retention近傍、db/Worker型と必須全体、nativeD1必要範囲、diff/patch同一性/限定review。
到達: epoch逆戻りなし、古い判定はconflict、監査/元request/新held状態が保全。別候補malformed dateは混ぜず調査記録へ。

追加同経路: 限定reviewでevent/exact0件でも現在epoch=e+1ならwildcardだけ書換える競合を指摘。実SQLite F36-cas-red.log 1FAIL19PASSでunknown→releasedの部分書換え再現。transition固有の挿入event IDを両hold UPDATEの条件へ追加し、失敗CASが副作用を残さないことも到達条件に含める。公開引数/schemaは不変。
