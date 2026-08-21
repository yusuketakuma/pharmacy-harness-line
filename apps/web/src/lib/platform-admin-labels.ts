// 全体管理者画面向けの日本語ラベル。未知の値はそのまま表示する。
export const STATUS_LABELS: Record<string, string> = { active: '稼働中', suspended: '停止中' }
export const ROLE_LABELS: Record<string, string> = { owner: 'オーナー', admin: '管理者', staff: 'スタッフ' }

export const tenantStatusLabel = (status: string): string => STATUS_LABELS[status] ?? status
export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role
