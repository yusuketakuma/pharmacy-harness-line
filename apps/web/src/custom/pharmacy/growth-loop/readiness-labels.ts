// 設定診断 (readiness) 系ステータスの日本語ラベル。
// API の生ステータス文字列を画面に直接出さず、ここを通して表示する。

const READINESS_STATUS_LABELS: Record<string, string> = {
  READY: '準備完了', BLOCKED: '要対応', CURRENT: '一致', STALE: '未反映', UNVERIFIED: '未確認',
  VERIFIED: '確認済み', MISSING: '未設定',
}

export function readinessStatusLabel(status: string): string {
  return READINESS_STATUS_LABELS[status] ?? status
}
