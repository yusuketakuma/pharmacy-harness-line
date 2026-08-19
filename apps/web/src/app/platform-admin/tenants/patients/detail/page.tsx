'use client'
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  isSupportModeRequired,
  platformAdminApi,
  type PlatformPatientDetail,
} from '@/lib/platform-admin-api'
import { SupportModeRequired } from '@/components/platform-admin/support-mode'

const SEX_LABELS: Record<string, string> = {
  male: '男性', female: '女性', other: 'その他', prefer_not_to_say: '回答しない',
}
const RELATIONSHIP_LABELS: Record<string, string> = {
  self: '本人', child: '子', spouse: '配偶者', parent: '親', other: 'その他',
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 同じ形のテーブルをセクションごとに使い回す。 */
function Section<T>({ title, rows, columns }: {
  title: string
  rows: T[]
  columns: Array<[string, (row: T) => ReactNode]>
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 font-semibold">{title}<span className="ml-2 text-xs font-normal text-gray-500">{rows.length}件</span></h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">データなし</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>{columns.map(([label]) => <th key={label} className="px-3 py-2">{label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t border-gray-100">
                  {columns.map(([label, render]) => (
                    <td key={label} className="px-3 py-2 align-top">{render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PatientDetail({ tenantId, patientId }: { tenantId: string; patientId: string }) {
  const [detail, setDetail] = useState<PlatformPatientDetail | null>(null)
  const [error, setError] = useState('')
  // 403 は「サポートモード未開始」だけを意味する。一般エラーとは分けて扱う。
  const [grantMissing, setGrantMissing] = useState(false)

  const load = useCallback(() => {
    setError('')
    setGrantMissing(false)
    platformAdminApi.patient(tenantId, patientId)
      .then((res) => setDetail(res.data))
      .catch((caught: Error) => {
        if (isSupportModeRequired(caught)) setGrantMissing(true)
        else setError(caught.message)
      })
  }, [tenantId, patientId])

  useEffect(load, [load])

  if (grantMissing) return <SupportModeRequired tenantId={tenantId} onStarted={load} />
  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>
  if (!detail) return <p className="text-sm text-gray-500">読み込み中...</p>

  const patient = detail.patient
  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/platform-admin/tenants/patients?id=${encodeURIComponent(tenantId)}`}
          className="text-sm text-purple-800 underline"
        >
          ← 患者一覧
        </Link>
        <h1 className="mt-2 text-xl font-bold">{patient.name}</h1>
        <p className="text-xs text-gray-500">
          患者ID <span className="font-mono">{patient.id}</span> / LINEアカウント <span className="font-mono">{detail.lineAccountId}</span>
        </p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">患者プロフィール</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-gray-500">氏名</dt><dd>{text(patient.name)}</dd></div>
          <div><dt className="text-gray-500">カナ</dt><dd>{text(patient.name_kana)}</dd></div>
          <div><dt className="text-gray-500">生年月日</dt><dd>{text(patient.birth_date)}</dd></div>
          <div><dt className="text-gray-500">性別</dt><dd>{patient.sex ? SEX_LABELS[patient.sex] ?? patient.sex : '—'}</dd></div>
          <div><dt className="text-gray-500">続柄</dt><dd>{RELATIONSHIP_LABELS[patient.relationship] ?? patient.relationship}</dd></div>
          <div><dt className="text-gray-500">電話</dt><dd>{text(patient.contact_phone)}</dd></div>
          <div><dt className="text-gray-500">郵便番号</dt><dd>{text(patient.postal_code)}</dd></div>
          <div><dt className="text-gray-500">都道府県</dt><dd>{text(patient.prefecture)}</dd></div>
          <div><dt className="text-gray-500">市区町村</dt><dd>{text(patient.city)}</dd></div>
          <div><dt className="text-gray-500">住所1</dt><dd>{text(patient.address_line1)}</dd></div>
          <div><dt className="text-gray-500">住所2</dt><dd>{text(patient.address_line2)}</dd></div>
          <div><dt className="text-gray-500">アーカイブ</dt><dd>{text(patient.archived_at)}</dd></div>
          <div><dt className="text-gray-500">作成</dt><dd>{text(patient.created_at)}</dd></div>
          <div><dt className="text-gray-500">更新</dt><dd>{text(patient.updated_at)}</dd></div>
        </dl>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">問診（最新回答）</h2>
        {detail.latestIntake ? (
          <>
            <p className="mb-2 text-xs text-gray-500">
              第{detail.latestIntake.revision}版 / schema v{detail.latestIntake.schema_version} / 回答日時 {text(detail.latestIntake.created_at)}
              {' / '}代理同意 {text(detail.latestIntake.representative_consent_at)}
              {' / '}個人情報同意 {text(detail.latestIntake.privacy_consent_at)}
            </p>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              {Object.entries(detail.latestIntake.answers).map(([key, value]) => (
                <div key={key}><dt className="text-gray-500">{key}</dt><dd>{text(value)}</dd></div>
              ))}
            </dl>
          </>
        ) : <p className="text-sm text-gray-500">データなし</p>}
      </section>

      <Section
        title="問診回答履歴"
        rows={detail.intakes}
        columns={[
          ['回答ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['版', (row) => row.revision],
          ['schema', (row) => row.schema_version],
          ['代理同意', (row) => text(row.representative_consent_at)],
          ['個人情報同意', (row) => text(row.privacy_consent_at)],
          ['回答日時', (row) => text(row.created_at)],
        ]}
      />

      <Section
        title="処方箋"
        rows={detail.prescriptions}
        columns={[
          ['受付ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['状態', (row) => row.status],
          ['有効リビジョン', (row) => text(row.active_revision)],
          ['希望受取', (row) => text(row.desired_pickup_at)],
          ['申込', (row) => text(row.requested_at)],
          ['クローズ', (row) => text(row.closed_at)],
          ['作成', (row) => text(row.created_at)],
          ['更新', (row) => text(row.updated_at)],
        ]}
      />

      <Section
        title="調剤クオート"
        rows={detail.quotes}
        columns={[
          ['クオートID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['受付ID', (row) => <span className="font-mono text-xs">{row.submission_id}</span>],
          ['判定', (row) => row.decision],
          ['状態', (row) => text(row.status)],
          ['受取予定', (row) => text(row.estimated_ready_at)],
          ['受取方法', (row) => text(row.fulfillment_method)],
          ['作成', (row) => text(row.created_at)],
        ]}
      />

      <Section
        title="継続フォロー"
        rows={detail.continuity}
        columns={[
          ['ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['状態', (row) => row.status],
          ['次回予定（開始）', (row) => text(row.expected_next_from)],
          ['次回予定（終了）', (row) => text(row.expected_next_to)],
          ['次回連絡', (row) => text(row.next_contact_at)],
          ['リマインド回数', (row) => row.reminder_count],
          ['作成', (row) => text(row.created_at)],
          ['更新', (row) => text(row.updated_at)],
        ]}
      />

      <Section
        title="服薬フォローアップ"
        rows={detail.medicationFollowUps}
        columns={[
          ['ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['元受付ID', (row) => <span className="font-mono text-xs">{row.source_submission_id}</span>],
          ['状態', (row) => row.status],
          ['期限', (row) => text(row.due_at)],
          ['送信', (row) => text(row.delivered_at)],
          ['回答', (row) => text(row.responded_at)],
          ['クローズ', (row) => text(row.closed_at)],
          ['版', (row) => row.version],
          ['更新', (row) => text(row.updated_at)],
        ]}
      />

      <Section
        title="次回受診予定"
        rows={detail.nextIntakeExpectations}
        columns={[
          ['ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['継続フォローID', (row) => <span className="font-mono text-xs">{row.obligation_id}</span>],
          ['状態', (row) => row.status],
          ['入力方法', (row) => row.timing_source],
          ['服用日数', (row) => text(row.supply_days)],
          ['予定（開始）', (row) => text(row.expected_from)],
          ['予定（終了）', (row) => text(row.expected_to)],
          ['お知らせ日時', (row) => text(row.reminder_at)],
          ['お知らせ済み', (row) => text(row.reminded_at)],
          ['更新', (row) => text(row.updated_at)],
        ]}
      />

      <Section
        title="マイナ連携"
        rows={detail.mynaHandoffs}
        columns={[
          ['ID', (row) => <span className="font-mono text-xs">{row.id}</span>],
          ['状態', (row) => row.status],
          ['方式', (row) => row.method],
          ['起点', (row) => row.source],
          ['相関ID', (row) => <span className="font-mono text-xs">{row.correlation_id}</span>],
          ['起動', (row) => text(row.launched_at)],
          ['患者申告', (row) => text(row.patient_reported_at)],
          ['期限', (row) => text(row.expires_at)],
          ['クローズ', (row) => text(row.closed_at)],
        ]}
      />

      <Section
        title="タイムライン"
        rows={detail.timeline}
        columns={[
          ['日時', (row) => text(row.occurred_at)],
          ['種別', (row) => row.kind],
          ['内容', (row) => row.label],
          ['状態', (row) => text(row.status)],
        ]}
      />
    </div>
  )
}

function PatientDetailRoute() {
  const params = useSearchParams()
  const tenantId = params.get('id')
  const patientId = params.get('patientId')
  if (!tenantId || !patientId) {
    return <p className="text-sm text-gray-500">テナント ID と患者 ID が必要です</p>
  }
  return <PatientDetail tenantId={tenantId} patientId={patientId} />
}

export default function PlatformAdminPatientDetailPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">読み込み中...</p>}>
      <PatientDetailRoute />
    </Suspense>
  )
}
