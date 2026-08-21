// 問診（患者アンケート）の回答ラベル。テナント管理画面と全体管理者画面で共有する単一定義。
import type { PharmacyPatient } from './api'

export const RELATIONSHIP_LABELS: Record<PharmacyPatient['relationship'], string> = {
  self: '本人', child: '子ども', spouse: '配偶者', parent: '親', other: 'その他',
}
export const SEX_LABELS: Record<string, string> = { male: '男性', female: '女性', other: 'その他', prefer_not_to_say: '回答しない' }

export const STATUS_LABELS: Record<string, string> = { none: 'なし', yes: 'あり', unknown: 'わからない' }
export const NOTEBOOK_LABELS: Record<string, string> = { paper: '紙', electronic: '電子', none: '持っていない', unknown: 'わからない' }
export const PREGNANCY_LABELS: Record<string, string> = { not_applicable: '該当なし', yes: 'あり', no: 'なし', unknown: 'わからない' }
export const SMOKING_LABELS: Record<string, string> = { never: '吸わない', former: '過去に吸っていた', current: '現在吸っている', unknown: 'わからない' }
export const ALCOHOL_LABELS: Record<string, string> = { none: '飲まない', occasional: 'たまに', weekly: '週1〜2日', frequent: '週3日以上', unknown: 'わからない' }
export const ADHERENCE_LABELS: Record<string, string> = { none: 'ほぼない', sometimes: 'ときどきある', often: 'よくある', unknown: 'わからない' }
export const MEDICAL_HISTORY_TAG_LABELS: Record<string, string> = {
  hypertension: '高血圧', diabetes: '糖尿病', dyslipidemia: '脂質異常症', heart_disease: '心臓の病気',
  kidney_disease: '腎臓の病気', liver_disease: '肝臓の病気', asthma: '喘息', other: 'その他',
}

// 質問キー → 表示名。値の選択肢は ANSWER_VALUE_LABELS で引く（自由記述はそのまま表示）。
export const INTAKE_QUESTION_LABELS: Record<string, string> = {
  allergiesStatus: 'アレルギー', allergies: 'アレルギーの内容',
  adverseReactionStatus: '副作用経験', adverseReactions: '副作用の内容',
  medicationStatus: '服用中の薬', medicationSummary: '服用中の薬の内容',
  medicalHistoryStatus: '既往歴・通院', medicalHistoryTags: '既往歴', medicalHistory: '既往歴の内容',
  medicationNotebook: 'お薬手帳', smokingStatus: '喫煙', alcoholStatus: '飲酒',
  medicationAdherence: 'お薬の飲み忘れ', pregnancyStatus: '妊娠の可能性', breastfeedingStatus: '授乳中',
  notes: '連絡事項',
}

const ANSWER_VALUE_LABELS: Record<string, Record<string, string>> = {
  allergiesStatus: STATUS_LABELS, adverseReactionStatus: STATUS_LABELS, medicationStatus: STATUS_LABELS,
  medicalHistoryStatus: STATUS_LABELS, medicalHistoryTags: MEDICAL_HISTORY_TAG_LABELS,
  medicationNotebook: NOTEBOOK_LABELS, smokingStatus: SMOKING_LABELS, alcoholStatus: ALCOHOL_LABELS,
  medicationAdherence: ADHERENCE_LABELS, pregnancyStatus: PREGNANCY_LABELS, breastfeedingStatus: PREGNANCY_LABELS,
}

export function intakeQuestionLabel(key: string): string {
  return INTAKE_QUESTION_LABELS[key] ?? key
}

export function intakeAnswerText(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '未回答'
  const labels = ANSWER_VALUE_LABELS[key]
  const one = (item: unknown) => labels?.[String(item)] ?? String(item)
  if (Array.isArray(value)) return value.length === 0 ? '未回答' : value.map(one).join('、')
  if (typeof value === 'object') return JSON.stringify(value)
  return one(value)
}
