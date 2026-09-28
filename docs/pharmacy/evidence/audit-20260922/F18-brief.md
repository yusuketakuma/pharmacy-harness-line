# F18 app redirect URL serialization
FIX candidate, P=87e6987, primary/dev. Scope tracked-links.ts/tests. HTML escaping is used inside script raw text: query & becomes &amp;, URL may terminate script element. Expected preserve original URL and intent fallback bytes, URLs remain data. Keep domains, routing, Android package, legacy plain redirect/pharmacy behavior/API. RED/GREEN generated HTML execution, relevant regression/type/integration/build and browser if feasible. No production/network, existing diffs preserved.

CONFIRMED_BUG/P1 generic app redirect。F18-red.log 3FAIL/16PASS exit1: 通常query/引用符URLが変化、script終端payloadでscript要素増加。Pの既存16tests維持、3cases追加。修正はscript用JSON.stringify + '<' unicode escape、noscript属性はHTML escape。Android intent構造/encoded fallback、Safariのraw URLをNode vmでassert。F18-near.log初回1FAILはnoscript属性内の未escape '<'をregexが拾ったため（その属性内の文字列単体でXSSが成立したという意味ではない）。属性もHTML escapeへ揃えF18-final-near.log19PASS exit0。

実browser: 一時testで実routeのHTMLをF18-html.jsonへ出力（F18-html-capture.log3PASS/16filter-skip、temporary test削除）、F18-browser.mjsのChromiumが実HTMLを読みURL navigationを捕捉。通常query/引用符・日本語/無害なscript-marker3cases全PASS、外部requestはroute.abortで遮断。URLのbrowser標準percent encodingをnew URL(url).hrefと比較。marker未実行確認。Android実OSのapp起動は未実施、intent文字列はNode vm検証。

互換契約: 公開export/API/DB形式/対象domain/Android package不変。修正前の誤変換だけ意図的に修正。helperはprivate function内、module分割なし。P/W hashesとF18.patch保存、隔離Pへ再適用しW完全一致。既存PLANS/evidence維持。独立レビュー未実施。

INTEGRATED 412c6c958c96b29c179ec64f14b3337d3cdb499f。integration-F18-verify.log全verify:ci exit0（型検査含む）。F18-worker-artifact-run.py build/runtime0、F18-worker-artifact.jsonに全成果物hash/bytesとstartup/auth/webhook防壁証拠。転送HTMLはsource route+browserで検証、compiled artifactの当転送route E2Eは未実施。Node26/pnpm11、CI Node22未実行。commitは2filesのみ、push/deploy無し。
