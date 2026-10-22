# apps/liff — 患者向け LIFF アプリ (React + Vite)

ルートの `AGENTS.md` の規約が優先。利用者は高齢者を含む患者。**マニュアル無しで操作できる**ことが要件。

## 地図

| パス | 役割 |
|---|---|
| `src/App.tsx` | ルーティングと画面タイトル。薬局ビルドは `/pharmacy/*` |
| `src/custom/pharmacy/menu/` | メインメニュー(`MainMenuPage`)、機能 ON/OFF ゲート(`PharmacyFeatureGate`) |
| `src/custom/pharmacy/prescriptions/` | 処方せん事前送信・電子処方箋タブ・受付状況(`PrescriptionPage`) |
| `src/custom/pharmacy/intake/` | 患者情報登録(`PatientProfileForm`)とアンケート(`PatientQuestionnaire`、3 ステップ) |
| `src/custom/pharmacy/continuity/`, `medication-followup/` | 継続フォロー / 服薬後フォロー |
| `src/custom/pharmacy/emergency-contraception/` | 緊急避妊薬の仮受付(同意 → 最小確認 → 枠選択) |
| `src/custom/pharmacy/public-profile/` | 薬局情報 |
| `src/custom/pharmacy/myna/`, `rich-menu/` | 電子処方箋 handoff、リッチメニュー関連 |
| `src/lib/liff-auth.ts` | LIFF 初期化と ID token 取得(権限の根拠はサーバー側検証) |
| `src/lib/startup-error.ts` | 起動失敗時の患者向け固定文言(技術詳細は console のみ) |
| `src/legacy-route.ts` | 旧 URL → 薬局メニューへの誘導 |
| `src/pages/`, `src/components/` | フォーク元の汎用 LIFF 画面(予約・ウェビナー・アフィリエイト)。薬局ビルドでは未使用 |

## UI ルール

- タップ領域 `min-h-11`、本文 `text-base` 以上、英語の技術文言を患者に見せない。
- 送信ボタンが押せない理由を一覧表示し、エラーは該当フィールドの近くに出してフォーカス/スクロールする。
- PHI を送る前に確認ブロック、送信後は「次にやること」を表示。
- 日時入力はネイティブ `<input type="datetime-local">`、「処方せん」表記(「電子処方箋」は例外)。
- テスト: `pnpm --filter liff test`、型: `pnpm --filter liff exec tsc --noEmit`。
