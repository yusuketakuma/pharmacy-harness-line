'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAccount } from '../../../contexts/account-context'
import { prescriptionAdminApi, type PrescriptionFile } from './api'
import { pharmacyPrintApi, type PharmacyPrintJob } from '../print/api'

export function printablePrescriptionFiles(
  files: PrescriptionFile[],
  activeRevision: number | null,
): PrescriptionFile[] {
  if (activeRevision === null) return []
  return files
    .filter((file) => file.state === 'ready' && file.revision === activeRevision)
    .sort((left, right) => left.position - right.position)
}

export function printablePrescriptionJobs(
  jobs: PharmacyPrintJob[],
  submissionId: string,
  activeRevision: number | null,
  fileIds: ReadonlySet<string>,
): PharmacyPrintJob[] {
  if (activeRevision === null) return []
  return jobs.filter((job) =>
    job.submission_id === submissionId &&
    job.revision === activeRevision &&
    fileIds.has(job.file_id),
  )
}

export default function PrescriptionPrintPage() {
  const params = useSearchParams()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const submissionId = params.get('submission_id')
  const [images, setImages] = useState<string[]>([])
  const [jobs, setJobs] = useState<PharmacyPrintJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  const [recorded, setRecorded] = useState(false)

  useEffect(() => {
    let disposed = false
    const urls: string[] = []
    if (!selectedAccountId || !submissionId) {
      setLoading(false)
      return () => undefined
    }
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const [detail, printQueue] = await Promise.all([
          prescriptionAdminApi.detail(selectedAccountId, submissionId),
          pharmacyPrintApi.list(selectedAccountId).catch(() => ({ jobs: [] })),
        ])
        const files = printablePrescriptionFiles(detail.files, detail.submission.active_revision)
        const blobs = await Promise.all(files.map((file) =>
          prescriptionAdminApi.image(selectedAccountId, submissionId, file.id),
        ))
        if (disposed) return
        for (const blob of blobs) urls.push(URL.createObjectURL(blob))
        setJobs(printablePrescriptionJobs(
          printQueue.jobs,
          submissionId,
          detail.submission.active_revision,
          new Set(files.map((file) => file.id)),
        ))
        setImages(urls)
      } catch {
        for (const url of urls) URL.revokeObjectURL(url)
        if (!disposed) setError('印刷する画像を取得できませんでした。')
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [selectedAccountId, submissionId])

  const print = useCallback(() => window.print(), [])

  const recordPrinted = useCallback(async () => {
    if (!selectedAccountId || recording || jobs.length === 0) return
    setRecording(true)
    try {
      for (const job of jobs) {
        const claimed = await pharmacyPrintApi.claim(selectedAccountId, job.id)
        await pharmacyPrintApi.printed(selectedAccountId, claimed.job.id)
      }
      setRecorded(true)
    } catch {
      setError('印刷済み状態を保存できませんでした。')
    } finally {
      setRecording(false)
    }
  }, [jobs, recording, selectedAccountId])

  if (accountLoading || loading) return <p className="p-8 text-center text-gray-500">印刷画像を準備中...</p>
  if (!selectedAccountId || !submissionId) return <p className="p-8 text-center text-gray-500">印刷対象が指定されていません。</p>
  if (error) return <p className="p-8 text-center text-red-600">{error}</p>
  if (images.length === 0) return <p className="p-8 text-center text-gray-500">印刷できる画像がありません。</p>

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-gray-900">処方せん画像を印刷</h1>
          <p className="text-sm text-gray-500">薬局内のプリンターを選び、印刷後は画面を閉じてください。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={print} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">
            印刷
          </button>
          {jobs.length > 0 && <button type="button" onClick={() => void recordPrinted()} disabled={recording || recorded} className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
            {recorded ? '印刷済み' : recording ? '保存中...' : '印刷済みを記録'}
          </button>}
        </div>
      </div>
      <section className="space-y-4" aria-label="処方せん画像">
        {images.map((src, index) => (
          <img key={src} src={src} alt={`処方せん画像 ${index + 1}`} className="mx-auto block max-w-full break-after-page" />
        ))}
      </section>
      <style jsx global>{`
        @media print {
          @page { margin: 8mm; }
          body { background: white; }
          img { max-height: 280mm; object-fit: contain; }
        }
      `}</style>
    </main>
  )
}
