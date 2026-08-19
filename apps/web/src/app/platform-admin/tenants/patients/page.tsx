'use client'
import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  isSupportModeRequired,
  platformAdminApi,
  type PlatformPatient,
} from '@/lib/platform-admin-api'
import { SupportModeRequired } from '@/components/platform-admin/support-mode'

const RELATIONSHIP_LABELS: Record<PlatformPatient['relationship'], string> = {
  self: '本人',
  child: '子',
  spouse: '配偶者',
  parent: '親',
  other: 'その他',
}

const SEX_LABELS: Record<string, string> = {
  male: '男性',
  female: '女性',
  other: 'その他',
  prefer_not_to_say: '回答しない',
}

function PatientList({ tenantId }: { tenantId: string }) {
  const [patients, setPatients] = useState<PlatformPatient[] | null>(null)
  const [error, setError] = useState('')
  // 403 は「サポートモード未開始」だけを意味する。一般エラーとは分けて扱う。
  const [grantMissing, setGrantMissing] = useState(false)

  const load = useCallback(() => {
    setError('')
    setGrantMissing(false)
    platformAdminApi.patients(tenantId)
      .then((res) => setPatients(res.data))
      .catch((caught: Error) => {
        if (isSupportModeRequired(caught)) setGrantMissing(true)
        else setError(caught.message)
      })
  }, [tenantId])

  useEffect(load, [load])

  return (
    <div>
      <Link
        href={`/platform-admin/tenants/detail?id=${encodeURIComponent(tenantId)}`}
        className="text-sm text-purple-800 underline"
      >
        ← テナント詳細
      </Link>
      <h1 className="mt-2 mb-4 text-xl font-bold">患者一覧</h1>
      {grantMissing && <SupportModeRequired tenantId={tenantId} onStarted={load} />}
      {error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}
      {!patients && !error && !grantMissing && <p className="text-sm text-gray-500">読み込み中...</p>}
      {patients && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2">氏名</th>
                <th className="px-3 py-2">カナ</th>
                <th className="px-3 py-2">生年月日</th>
                <th className="px-3 py-2">性別</th>
                <th className="px-3 py-2">続柄</th>
                <th className="px-3 py-2">電話</th>
                <th className="px-3 py-2">LINEアカウント</th>
                <th className="px-3 py-2">状態</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((patient) => (
                <tr key={`${patient.lineAccountId}:${patient.id}`} className="border-t border-gray-100">
                  <td className="px-3 py-2">
                    <Link
                      href={`/platform-admin/tenants/patients/detail?id=${encodeURIComponent(tenantId)}&patientId=${encodeURIComponent(patient.id)}`}
                      className="text-purple-800 underline"
                    >
                      {patient.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{patient.name_kana}</td>
                  <td className="px-3 py-2">{patient.birth_date}</td>
                  <td className="px-3 py-2">{patient.sex ? SEX_LABELS[patient.sex] ?? patient.sex : '—'}</td>
                  <td className="px-3 py-2">{RELATIONSHIP_LABELS[patient.relationship] ?? patient.relationship}</td>
                  <td className="px-3 py-2">{patient.contact_phone ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{patient.lineAccountId}</td>
                  <td className="px-3 py-2">{patient.archived_at ? 'アーカイブ済み' : '有効'}</td>
                </tr>
              ))}
              {patients.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">患者が登録されていません</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PatientListRoute() {
  const tenantId = useSearchParams().get('id')
  if (!tenantId) return <p className="text-sm text-gray-500">テナント ID が指定されていません</p>
  return <PatientList tenantId={tenantId} />
}

export default function PlatformAdminTenantPatientsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">読み込み中...</p>}>
      <PatientListRoute />
    </Suspense>
  )
}
