# Myna 起動URL（`/r/myna/:token`）契約

## 目的

患者に送る Myna 起動リンクは `tenant_alias` を公開URLに含めない。alias は
テナントを列挙可能な準静的識別子であり、以前の `/r/myna/:tenantAlias` は
未認証・レート制限対象外だったため alias 総当たりでエンドポイントURLが
漏洩し得た（NEXT-1）。

## トークン形式

- `base64url(lineAccountId|exp)` + `.` + `base64url(HMAC-SHA256 署名)`
- 署名鍵は `MYNA_ENDPOINT_ENCRYPTION_KEY` から HMAC 派生（
  `myna-endpoint:launch-token:2` ラベル）。既存の endpoint 暗号鍵とは
  別鍵になるため、暗号鍵の使い回しはない
- 検証は `crypto.subtle.verify`（定数時間）で行う

## 有効期限

30分。`repository.ts` の `createMynaHandoff` が設定する handoff 有効期限
（30分）と一致させている。handoff 失効後は起動リンクも無意味なため。

## 404の一様性

未知トークン・改ざんされた署名・期限切れトークン・（トークンは有効でも）
対象アカウントの endpoint が無効化されている場合、すべて同一の
`Myna受付を利用できません`（404, 本文・ヘッダー同一）を返す。どのケースに
該当したかをレスポンスから区別できない。

## レート制限

`/r/myna/` は `middleware/rate-limit.ts` で他の `/r/` 配下（共有リンク等）
とは別扱いにし、未認証パスとして IP キーでレート制限する。

## 転送しない情報

リダイレクトは `tenant_alias` も患者・LINE識別子も一切転送しない。`Location`
ヘッダーは DB に保存された endpoint URL のみ。`Cache-Control: no-store` /
`Referrer-Policy: no-referrer` / `Content-Security-Policy: default-src 'none'`
を維持する。
