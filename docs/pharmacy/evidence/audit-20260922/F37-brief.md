# F37 FIX — 全PHI sourceの集計をnative D1で実行可能にする
P=6164b456e82b1cf2c6c572fcfa2e92caeb7f9c9b、primary/dev、CONFIRMED_BUG/P2。
書込範囲: legal-hold.ts + packages/db/test/retention-d1.test.ts。依存: 全source定義/既存legal hold契約、DSR/retention fence callers、Miniflare(既存wrangler同梱)。新依存取得なし。
根拠: F36-native-diagnostic2.log。既存SQLite testでは成功するqueryが実D1ではtoo many terms in compound SELECT、assessment unknown固定。全基礎PHIが期限切れでもerasureを完了できない。
保持契約: 全sourceを読む、NULL/不正timestamp/読取失敗はunknown、tenant/account/patient/owner binding、公開exportとAPI/保存形式/期間。単一SQL statementの同一snapshotを維持。個別sourceを省略しない。
設計候補: patient/ownerの既存2群をnested compound SELECTとして結合し、各compoundのterm数を抑える。同一query/同じbind順、UNION ALL/row重複/NULL保持。
検証: 実Miniflare D1で旧query RED→GREEN、古い/新しいpatient・owner・foreign・不正source、既存DSR/retention tests、型/必要統合、compiled routeからerasure正常workflow。全体freshreviewは別。
性能保全: query数1のまま。旧新better-sqlite3で同一合成50/500/5000 owner message行、warm3/9測定、中央値W<=max(2P,P+15ms)。本番・外部なし。
参考: https://developers.cloudflare.com/d1/platform/limits/ (2026-09-22確認) はSQL100KB/100bind等を示すがcompound上限値記載なし。今回のcompound失敗はlocal workerd/D1実測を根拠にし、未掲載値を公式保証としない。

設計更新: 2群だけへの分割ではnative仍失敗(F37-near.log)。F37-limit-probe.jsonで5term成功/10term失敗、5termを2/4groupへnest成功、7groupは失敗を実測。5本ずつ階層化して各compoundを5以下に収める内部helperへ変更。全source/順序/同一statementは保持。正確なnative上限値自体は未確定、採用値5の成功を根拠にする。
