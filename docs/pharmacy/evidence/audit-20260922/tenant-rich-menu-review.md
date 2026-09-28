# Tenant rich-menu child mutation 限定調査

ID: TRM-LR。担当 audit_db（既存thread）、snapshot HEAD `da40c463db40423af8bbc32ce2ade603949bcffb`。read-only調査。fresh全体最終独立レビューではない。

結論: F31と同じ「認可済parent URL + 無関係child ID」を単独リクエストで渡す更新/削除経路は、読んだ範囲では反証できた。確定bugなし。画像の最終UPDATEはpage IDのみなので競合時の実行時scopeは別途concernとして残す。

| 読取path | SHA256 |
|---|---|
| `apps/worker/src/middleware/tenant-boundary.ts` | `488672889bcae25bfea5460452af10aa7d36f704a2ce081c83327c7c431ca3bf` |
| `apps/worker/src/routes/messaging/rich-menu-groups.ts` | `a7b2f82cd3d2b2817ad1843714bfbd6a6f42e0b4df5e86e82313698c4f035824` |
| `packages/db/src/rich-menus.ts` | `2b42747943681834a583793575e22cf91e3ff286cb4a1a3cee1dff50390f7569` |
| `apps/worker/src/routes/messaging/rich-menu-groups.test.ts` | `f41007814aaebda68c013ec5930a6f87d919fd80fc32ed3689c30800cdf3ceac` |
| `packages/db/schema.sql` | `ae1424d1a2f212045d60b88030284da2aa4285dface225782bc5e1cdf2f11d49` |

## 入口→DBと保持契約

- `tenantRichMenuResourceGuard`（tenant-boundary.ts:178–215）はgroupをIDで解決し、accountResourceOwnedByStaffで認証tenant/staffのaccount所有を確認する。tenantなしの既存挙動はskipであり、全認証経路の安全をこの調査で認定しない。
- `POST /api/rich-menu-groups/:groupId/pages/:pageId/image`（route:877–920）は画像body処理/R2 putより前に `pageBelongsToGroup` を要求する。DB helper:450 のSQLは `id=? AND group_id=?`。別group pageは404で停止する。group取得後もgroupMatchesAccountScope→getScopedLineAccountでserver tenantを使う。immutable guardもある。画像keyは取得group.account_id+URLgroup/pageから生成。
- `PATCH /api/rich-menu-groups/:groupId`（819–844）はpages配列を受ける。parsePageInput/parsePages（237–290）はID/順序/重複を検証。`replaceRichMenuPages`（DB:304–423）は認可groupのpageだけをSELECTしexistingMap作成。そのmapにない他group ID/stale IDは新UUID扱い。別groupのmetadataやIDを採用せず、DELETEは `WHERE group_id=?`、INSERTも認可groupIdをbind。area IDは入力を利用せず新UUIDを生成し、対応するpageへbind。default_page_idも新構成のown pageにする。
- `DELETE /api/rich-menu-groups/:groupId`（846–873）は取得groupのaccount scope/immutable/published状態を確認し、group IDで削除。schemaのpage→group、area→page FK CASCADEで当該group配下に限定。独立した `DELETE .../pages/:pageId` やarea ID更新ルートは対象routes検索では見つからない。
- parsePatchBodyはaccount/default page任意付替えを採用しない。groupMeta更新もname/chatBarText/selectedの固定fieldであり、任意のchild IDを書き込む経路ではない。

## concern と限界

TRM-C1（確定bugではない、静的構造の確度高・悪用成立未確認）: imageの所属SELECTと `setRichMenuPageImage` のUPDATEは非原子的で、最終SQLは `WHERE id=?` のみ。所属確認後に別権限のwriterが同一page IDを別groupへ移す/再作成すれば、staleリクエストがそちらを更新する可能性は構造上ある。ただし調査したreplace処理はforeign IDをUUIDに替え、通常APIから任意ID移管する経路は確認できない。`SET group_id`検索でも対象sourceに該当なし。F31同等のconfirmed cross-tenant bugとは扱わない。page削除との競合ならR2 objectだけ残ってUPDATE0件でもsuccessになり得るが、これも今回のparent混同と別の競合保証。

最小追加検証案（未実行）: actualSQLite bootstrapにgroup A/Bとpage A/B、合成tenant A/実guard/route、stub R2を用意し、A URL+B page image→404/R2 put0/DB不変、A PATCH pages中B ID→A新UUID/B全row不変、A group delete→B page/area保持を確認。TRM-C1を検証するなら所属SELECT後に合成DBだけでpage移管を挟むが、その成立は外部writer仮定の検証であり通常API exploitの証明ではない。

## Coverage・実施コマンド・未実施

root/packages/Worker既読指示を適用。本文読取はguard該当部、route scoped account helper:67付近・parsePage/Pages:237–290・parsePatch/scope:343–387・group CRUD/image:780–920、DB:266–466、schema:2269付近/2297–2318、route image test:599–697のみ。巨大routeのpublish/reconcile/resume/apply-to-tag/import/external処理全体は未読で、これらまでPASSを拡張しない。setRichMenuPageImage他caller（import/薬局storage）は名称探索のみで今回は監査していない。

既存image testは所属不一致404/immutable/成功等を持つがDB helperはmockであり実SQL統合証明ではない。testを実行していない。

`git rev-parse HEAD`、対象を絞る `rg -n`/`rg --files`、`sed`本文読取、Python hashlibにより上記snapshot/hashを記録。最初の広めrg結果がtruncateしたため対象route/helperに絞って再読。存在しないpackages/db/src/rich-menu-groups.ts検索は失敗し実rich-menus.tsへ解決。test globはzsh no matchesで失敗しrg --filesに切替。失敗を成功として扱わない。

独自test/実行再現/build/外部通信/実データアクセス/secret参照/spawnなし。source/Git変更・commit/patchなし。書込みはこの記録のみ。読み取った境界を越える認証・LINE配信・全richmenu機能安全の主張はしない。
