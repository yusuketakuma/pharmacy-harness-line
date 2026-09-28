# F35 FIX — 同じチャットの未保存メモを再取得で消さない
CONFIRMED_BUG/P2。P=abda3847979e19b906ebe3f81c61cfac03cf901c、primary/dev。
書込範囲: apps/web/src/app/chats/page.tsx、apps/web/e2e/chat-notes-race.e2e.ts。
根拠: chat-notes-browser-final-red.log、trace/screenshot。保存Aの待機中に編集B、成功後GETでAに戻る実ブラウザ再現。初回fixture不備の失敗は製品根拠に含めない。
保持契約: API payload/認可/保存形式/選択切替時の入力破棄/旧detail epoch fence。未保存メモの永続化や別患者への持越しは追加しない。
意図的差分: dirty draftは同一chatのstatus/save後refreshから保護。保存成功時は当該選択・編集revision一致時だけcleanへ。
検証: 保存中編集、通常保存後refresh、失敗とretry、status refresh、A→B→Aの遅延save。隔離合成APIの実Playwright、web unitと型。旧P再現を保全、外部API送信なし。
到達条件: 再現回帰PASS、既存web必須check、snapshot/patch再現と限定review。全体fresh reviewは別途未完。
