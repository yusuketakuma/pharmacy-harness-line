# F34 FIX: F32と同根のCRM例外出力境界

INTEGRATED、primary/dev。P=f3d3dc401a8859dd137bb9163752e9bb3425c124。scope: chats/conversationsの残るcatch出力と新privacy test3paths。F32と同じ根本原因の未被覆経路をまとめる。
仮説: チャット/operator登録更新のc.req.json例外が本文断片をconsoleへ出す。conversationsは依存例外をresponseにも出す。実route+合成入力/DBfaultで確認。
根拠: Worker AGENTSのrequest body/PHI/上流本文ログ禁止。保持: catch範囲、HTTP500、成功/認可/送信/保存契約。意図的差分: 固定ログイベント、conversationsの500 errorを固定Internal server errorへ変更（機密を含み得る内部例外の公開を止める）。エラーkey/型/statusは維持。
検証: 旧P RED→実route privacy14cases、既存CRM/認可/logging privacy、Worker全test/typecheck。patch隔離再現・限定レビュー。module/export/schema/build/依存変更なし。
