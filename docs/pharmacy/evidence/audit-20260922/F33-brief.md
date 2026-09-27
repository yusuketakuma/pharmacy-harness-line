# F33 FIX: chat consumersの時刻比較

INTEGRATED、primary/dev、P=044e817d2685edad303bc1fe0708200855c0e3a8。書込範囲はF33-input.jsonの3reader＋actualSQLite回帰test。先行調査chat-time-investigation.md、CONFIRMED_BUG/P2。
保持: schema/writer/raw timestamp strings/認可/送信/HTTP/旧before(strict timestamp)/既存limit。新依存/公開symbolなし。
意図的差分: UTC/JSTを瞬間で比較、MAXと選択row/cursor/orderを一致、一覧のpage sortを既存lastMessageAt契約（最新message日時、messageなしのみchat日時）へ合わせる。chat metadataの日時がpreviewと異なる場合も旧公開field意味を維持する。
検証: P regression RED→actualSQLite mixed/UTC/JST/day boundary/ms/tie/複合cursor/既存inboxルール/境界テスト、型/fullverify、nativeD1 query。性能は合成50/500/5000 messages（10friends）、SQLite同環境9回中央値、各reader SQL一式の許容増分 max(P中央値,15ms)、すなわちW<=max(2P,P+15ms)。失敗時は原因を調べ閾値を事後変更しない。QUERY PLANも記録。row scan数はSQLite工具未対応なら未測定と明示。
全データmigration/新indexは現時点で採択しない。旧dataの日時書換不要。nativeEngine/性能未検証のまま完了扱いしない。
