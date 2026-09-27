# 公開preview consumer監査

P=W=412c6c958c96b29c179ec64f14b3337d3cdb499f、primary/dev。前ターンはF18修復/回帰/browser/統合完了のprogress。本ターンは関連consumerの再探索。製品コード変更なし。

REVIEWED（このmoduleの現在の用途）: lib/og-html.ts全体と7tests、lib/og-resolver.ts全体と12tests。title/description/siteName/url/image URLはHTML escape、typeはunion/default固定で、全現行callerはresolverから生成し外部type値を渡さない。F18のscript内HTML entity混同はこのHTML-only builderに当てはまらない。resolverは文字列優先順位/空白/相対画像URL解決を行い、network fetchや保存副作用なし。schema不正型/全外部crawler動作の保証ではない。

PARTIAL: index.ts buildOgForLiffPath全体（877–987）、notFoundHandler全体（989–1035）、not-found.test73–110。eventはpublished/deleted/account-target条件付き、liff指定で不一致時にevent単独lookupへfallbackしない。指定無し公開eventは旧仕様で単独lookup許可。formはaccount mapping tenant IS form.tenant、薬局modeならgeneric event/form読取り前にdefault brandingへ。branding queryはpublic columnsのみでtokens/secretをSELECTしない。unknown APIはJSON404、assets欠落時404、HTML GETでasset404のみSPAfallback。これらをindex module全体REVIEWEDとはしない。

証拠: integration-F18-verify.logのog-html7/og-resolver12/not-found8 tests PASSを再利用、source/config変更なし。not-foundの薬局formテストは本文非出力だけでなくFROM forms未呼出しとsecret列非取得をassert。event公開/所属queryはsource照合であり、このテストが全event分岐を実DB検証したとの主張なし。今回新規test/browser/compiled preview E2Eなし。

tracked-linksの既読全体とDB moduleはF17/F18修復を含め局所確認済。ただし全legacy null所有契約、更新競合、非HTTP original_urlの受入、全auto-track callerは未確認でPARTIAL維持。公開bot previewは認証ではなく公開対象選別であり、bot判別だけをアクセス制御と扱わない。今回追加CONFIRMED_BUGなし。

次: 同一経路の証拠の増えない再確認を終え、scheduledのgeneric/pharmacy選別からcron consumerの未被覆へ。全C/X領域と最終独立レビューは未完。commit/patch非該当。Gitは既存PLANS/evidenceのみを保全。
