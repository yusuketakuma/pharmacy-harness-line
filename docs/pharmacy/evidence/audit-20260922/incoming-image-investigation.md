# INCOMING-IMAGE-20260922-01

P/W=385bd61f1d352c2fceff30bd8e20cbda4a00ab82。primary、source読取りと合成ローカル検証のみ。製品変更/commit/patchなし。全体Goal未完。

範囲: services/incoming-image.ts/immutable-r2.ts全体、incoming-image.test.ts1–172、retention/incoming-images.ts472–561/595–623、routes/admin/images.ts1–82/132–171、indexのmiddleware/route順、generic-feature-guard images条件。前ターンwebhook tracking consumerを再利用。

確認:
- LINE Content APIは固定originへ10秒AbortSignal、非成功/非許可MIME/10MiB超過でnull。無header時もstream累積上限あり。fetch/read/R2 errorは固定文言でlabel fallback。画像取得が失敗した場合は既存仕様でnullとなり、webhook自体の再試行を必ず起こす設計ではない。tracking DB insert失敗は別で再試行に戻る。
- tenant/account/messageを含むdeterministic R2key、SHA256、etagDoesNotMatch:*のimmutable put。条件不一致の場合だけHEAD SHA一致を確認して同byte再送を成功扱い。異byteはnull。
- retentionはhold/disposition/SHAの照合後に現在executionを確認し、読み取ったETag条件で空tombstoneへ置換。結果不明はOUTCOME_UNKNOWN。reconcileは欠落/tombstoneをFINALIZED_DELETEDへ進め、存在中のimageを盲目的に削除し直さない。
- /images公共入口はuploads形式のみでincoming key不許可。/api/images incoming読取りは認証tenant prefix+account staff access、private,no-store。generic DELETE実装は物理deleteだがpharmacy middlewareでは/api/images/*のDELETEを拒否するため、存在だけを薬局tombstone回避と断定しない。

新証拠: incoming-image-r2-smoke.mts/log/result.json。pnpm exec tsx <同file>、Node26.6.0、安全PATH/LANG/TMPDIR+CI/NO_COLOR/WRANGLER_SEND_METRICS=false、45秒上限。実source helper+Miniflare local R2、固定8byte synthetic PNG header、注入fetchのみ4回、外部通信禁止。初回binary一致→同byte再送成功→誤ETag削除拒否/byte保持→正ETagで空tombstone→同画像再送null/empty markerとETag保持→別account別keyで保存成功。exit0。mf.dispose完了。R2 key conflictの固定logは期待する拒否。生成WorkerのE2E/本番R2ではない。

既存同sourceのintegration-F15-verify.log: incoming-image7tests、incoming retention20tests、prescription retention31testsを再利用。全量再実行なし。

残項目: backup/importや外部lifecycle設定がtombstoneを保持する証拠は未確認のまま。active hold/失効の外部R2操作直前race全体は今回再現しない。incoming readerはgetReader後releaseLockなし（局所stream参照の生涯/資源影響を未計測）、identifier置換の異入力衝突は実際の発行ID契約未確認で懸念止まり。無条件で設定/保存方式を変更しない。新たなCONFIRMED_BUGなし。
