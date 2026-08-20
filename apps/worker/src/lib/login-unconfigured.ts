export function loginUnconfiguredPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <title>LINE ログインが未設定です</title>
</head>
<body>
  <main>
    <h1>LINE ログインが未設定です</h1>
    <p>管理者の方は、管理画面からLINEログインチャネルとLIFFを設定してください。</p>
  </main>
</body>
</html>`;
}
