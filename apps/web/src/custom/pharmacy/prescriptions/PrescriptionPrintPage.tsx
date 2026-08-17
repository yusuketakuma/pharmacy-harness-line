'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAccount } from '../../../contexts/account-context'
import { prescriptionAdminApi, type PrescriptionFile } from './api'
import { pharmacyPrintApi, type PharmacyPrintTask } from '../print/api'

export function printablePrescriptionFiles(
  files: PrescriptionFile[],
  activeRevision: number | null,
): PrescriptionFile[] {
  if (activeRevision === null) return []
  return files
    .filter((file) => file.state === 'ready' && file.revision === activeRevision)
    .sort((left, right) => left.position - right.position)
}

export function canAcknowledgePrint(
  printInvoked: boolean,
  recording: boolean,
  recorded: boolean,
): boolean {
  return printInvoked && !recording && !recorded
}

function operationId(submissionId: string): string {
  const key = `pharmacy-print:${submissionId}`
  const existing = sessionStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  sessionStorage.setItem(key, created)
  return created
}

export default function PrescriptionPrintPage() {
  const params = useSearchParams()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const submissionId = params.get('submission_id')
  const [images, setImages] = useState<string[]>([])
  const [loadedImages, setLoadedImages] = useState(0)
  const [task, setTask] = useState<PharmacyPrintTask | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  const [recorded, setRecorded] = useState(false)
  const [printInvoked, setPrintInvoked] = useState(false)

  useEffect(() => {
    let disposed = false
    const urls: string[] = []
    if (!selectedAccountId || !submissionId) {
      setLoading(false)
      return () => undefined
    }
    setLoading(true)
    setError('')
    setImages([])
    setLoadedImages(0)
    setPrintInvoked(false)
    void (async () => {
      try {
        const prepared = await pharmacyPrintApi.prepare(selectedAccountId, submissionId)
        if (prepared.task.status === 'acknowledged') {
          if (!disposed) {
            setTask(prepared.task)
            setRecorded(true)
          }
          return
        }
        const id = operationId(submissionId)
        const claimed = await pharmacyPrintApi.claim(selectedAccountId, prepared.task.id, id)
        const detail = await prescriptionAdminApi.detail(selectedAccountId, submissionId)
        if (detail.submission.active_revision !== claimed.task.revision) {
          throw new Error('stale prescription revision')
        }
        const files = printablePrescriptionFiles(detail.files, claimed.task.revision)
        if (files.length === 0) throw new Error('no printable files')
        const blobs = await Promise.all(files.map((file) =>
          prescriptionAdminApi.image(selectedAccountId, submissionId, file.id),
        ))
        if (disposed) return
        for (const blob of blobs) urls.push(URL.createObjectURL(blob))
        setTask(claimed.task)
        setSessionId(id)
        setImages(urls)
      } catch {
        for (const url of urls) URL.revokeObjectURL(url)
        if (!disposed) setError('印刷タスクを開始できませんでした。別の画面で操作中でないか確認してください。')
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [selectedAccountId, submissionId])

  const print = useCallback(() => {
    window.print()
    setPrintInvoked(true)
  }, [])

  useEffect(() => {
    if (images.length > 0 && loadedImages === images.length && !printInvoked) print()
  }, [images, loadedImages, print, printInvoked])

  const recordPrinted = useCallback(async () => {
    if (!selectedAccountId || !task || !sessionId || !canAcknowledgePrint(printInvoked, recording, recorded)) return
    setRecording(true)
    try {
      const result = await pharmacyPrintApi.acknowledge(selectedAccountId, task.id, sessionId)
      setTask(result.task)
      setRecorded(true)
    } catch {
      setError('印刷操作済みの記録を保存できませんでした。')
    } finally {
      setRecording(false)
    }
  }, [printInvoked, recorded, recording, selectedAccountId, sessionId, task])

  if (accountLoading || loading) return <p className="p-8 text-center text-gray-500">印刷画像を準備中...</p>
  if (!selectedAccountId || !submissionId) return <p className="p-8 text-center text-gray-500">印刷対象が指定されていません。</p>
  if (error) return <p role="alert" className="p-8 text-center text-red-600">{error}</p>
  if (recorded && images.length === 0) return <p className="p-8 text-center text-gray-600">この改訂は印刷操作済みとして記録されています。</p>
  if (images.length === 0) return <p className="p-8 text-center text-gray-500">印刷できる画像がありません。</p>

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-bold text-gray-900">処方せん画像を印刷</h1>
          <p className="text-sm text-gray-500">印刷画面を開きます。印刷後に操作済みとして記録してください。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={print} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">
            印刷画面を開く
          </button>
          <button
            type="button"
            onClick={() => void recordPrinted()}
            disabled={!canAcknowledgePrint(printInvoked, recording, recorded)}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {recorded ? '記録済み' : recording ? '保存中...' : '印刷操作済みとして記録'}
          </button>
        </div>
      </div>
      <section className="space-y-4" aria-label="処方せん画像">
        {images.map((src, index) => (
          <img
            key={src}
            src={src}
            alt={`処方せん画像 ${index + 1}`}
            onLoad={() => setLoadedImages((count) => count + 1)}
            onError={() => setError('印刷画像を表示できませんでした。')}
            className="mx-auto block max-w-full break-after-page"
          />
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
