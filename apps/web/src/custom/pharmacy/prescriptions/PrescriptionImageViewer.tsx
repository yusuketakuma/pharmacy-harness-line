'use client'

import React, { useEffect, useState } from 'react'

export function PrescriptionImageViewer({
  imageUrl,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  imageUrl: string
  position: number
  total: number
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrevious()
      if (event.key === 'ArrowRight') onNext()
      if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(3, value + 0.25))
      if (event.key === '-') setZoom((value) => Math.max(0.5, value - 0.25))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, onNext, onPrevious])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3" role="dialog" aria-modal="true" aria-label="処方せん画像">
      <div className="flex flex-wrap items-center justify-center gap-2 text-white">
        <button type="button" onClick={onPrevious} disabled={position <= 1} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">前の画像</button>
        <span aria-live="polite">{position} / {total}</span>
        <button type="button" onClick={onNext} disabled={position >= total} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">次の画像</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className="rounded bg-white/15 px-3 py-2">拡大</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} className="rounded bg-white/15 px-3 py-2">縮小</button>
        <button type="button" onClick={() => setRotation((value) => value - 90)} className="rounded bg-white/15 px-3 py-2">左回転</button>
        <button type="button" onClick={() => setRotation((value) => value + 90)} className="rounded bg-white/15 px-3 py-2">右回転</button>
        <button type="button" onClick={onClose} className="rounded bg-white px-3 py-2 text-black">閉じる</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, short-lived blob URL */}
        <img
          src={imageUrl}
          alt={`処方せん画像 ${position}`}
          className="max-h-full max-w-full object-contain transition-transform"
          style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
    </div>
  )
}
