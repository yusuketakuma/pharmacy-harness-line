'use client'

import React, { useEffect, useRef, useState } from 'react'

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
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  useEffect(() => { setPan({ x: 0, y: 0 }) }, [imageUrl])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrevious()
      if (event.key === 'ArrowRight') onNext()
      if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(3, value + 0.25))
      if (event.key === '-') setZoom((value) => Math.max(0.5, value - 0.25))
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')
        if (!controls?.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [onClose, onNext, onPrevious])

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3" role="dialog" aria-modal="true" aria-label="処方せん画像">
      <div className="flex flex-wrap items-center justify-center gap-2 text-white">
        <button type="button" onClick={onPrevious} disabled={position <= 1} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">前の画像</button>
        <span aria-live="polite">{position} / {total}</span>
        <button type="button" onClick={onNext} disabled={position >= total} className="rounded bg-white/15 px-3 py-2 disabled:opacity-40">次の画像</button>
        <button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className="rounded bg-white/15 px-3 py-2">拡大</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} className="rounded bg-white/15 px-3 py-2">縮小</button>
        <button type="button" onClick={() => setRotation((value) => value - 90)} className="rounded bg-white/15 px-3 py-2">左回転</button>
        <button type="button" onClick={() => setRotation((value) => value + 90)} className="rounded bg-white/15 px-3 py-2">右回転</button>
        <button ref={closeButtonRef} type="button" onClick={onClose} className="rounded bg-white px-3 py-2 text-black">閉じる</button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated, short-lived blob URL */}
        <img
          src={imageUrl}
          alt={`処方せん画像 ${position}`}
          draggable={false}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
          }}
          onPointerMove={(event) => {
            const start = dragRef.current
            if (start) setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y })
          }}
          onPointerUp={(event) => {
            dragRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          className="max-h-full max-w-full cursor-grab select-none object-contain active:cursor-grabbing"
          style={{ touchAction: 'none', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
        />
      </div>
    </div>
  )
}
