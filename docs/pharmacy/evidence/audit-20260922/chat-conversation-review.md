# チャット/会話の限定調査

P=da40c463db40423af8bbc32ce2ade603949bcffb、primary read-only調査＋F32のみ局所修正。範囲は chats.ts 全732行、conversations.ts 全324行（前継続で読取済）、手動送信test、outbound-line-delivery prepare/retireMissingPayload/deliverTrackedLinePush。

- chat IDとfriend IDの名前空間重複仮説: routeのresolveAuthorizedChatが実際に選択したchat.friend_idを再度requireFriendAccessへ通す。outerguardだけで認可したfriendとは別でも選択後のfriendが検証されるため、この通常経路の越境仮説は反証。全競合/DB書換は未確認。
- 手動sendの生例外ログはF32で再現・修復。
- pushの戻り値型にはnot_sentを含むが、実push経路とretireMissingPayloadはsent/already_sent/reconciliation_requiredのみ。型だけからsend routeが未送信を成功報告すると断定しない。
- 会話ページングはbeforeのjulianday比較に対しORDER BY文字列、同時刻のタイブレークcursor不足の可能性。保存日時の実形式/consumerをまだ照合しておらずconcern。
- chats一覧の通常limitは1..1000、unansweredOnlyは全件取得して後処理する。負荷の実測/SLO未確認のため欠陥断定なし。
- operators CRUDはこのroute自体ではtenant filterなし。設計上の全体管理入口かmiddlewareによる制限を次に照合する必要あり。generic operatorとpharmacy staffの同一視はしない。
- 他CRUDの生エラーログと不正JSONは追加確認対象。F32の保証を全CRM privacyへ広げない。

全CRM/会話/送信基盤の状態はPARTIAL。検証証拠はF32-result.md。DB mockと実DB検証は区別。
