"use client"

import { useEffect, useRef, useState } from "react"
import { Keyboard, PenLine, RotateCcw } from "lucide-react"

type Mode = "draw" | "type"

/**
 * Draw (PNG data URL) or type (full name) a signature, as the consumer
 * agreement page captures one. Reports the artefact, or null while there is
 * none, through onChange.
 */
export function SignaturePad({ onChange }: { onChange: (signature: string | null) => void }) {
  const [mode, setMode] = useState<Mode>("draw")
  const [typed, setTyped] = useState("")
  const [hasInk, setHasInk] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d")
    if (!ctx) return
    ctx.strokeStyle = "#1a1a1a"
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
  }, [mode])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    // Pointer coordinates are CSS pixels; the context draws in backing-store pixels.
    return { x: (e.clientX - rect.left) * (el.width / rect.width), y: (e.clientY - rect.top) * (el.height / rect.height) }
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext("2d")
    if (!ctx) return
    drawing.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y } = point(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = e.currentTarget.getContext("2d")
    if (!ctx) return
    const { x, y } = point(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasInk(true)
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    if (canvas.current) onChange(canvas.current.toDataURL("image/png"))
  }
  const clear = () => {
    const el = canvas.current
    el?.getContext("2d")?.clearRect(0, 0, el.width, el.height)
    setHasInk(false)
    onChange(null)
  }
  const switchTo = (next: Mode) => {
    setMode(next)
    setHasInk(false)
    setTyped("")
    onChange(null)
  }

  const tab = (value: Mode, label: string, Icon: typeof PenLine) => (
    <button
      type="button"
      onClick={() => switchTo(value)}
      aria-pressed={mode === value}
      className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium ${
        mode === value
          ? "border-[var(--cf-brand)] bg-[var(--cf-brand)] text-[var(--cf-on-brand)]"
          : "border-[var(--cf-border-strong)] text-[var(--cf-text-secondary)]"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  )

  return (
    <div className="space-y-3">
      <div className="flex gap-2">{tab("draw", "Draw", PenLine)}{tab("type", "Type", Keyboard)}</div>
      {mode === "draw" ? (
        <div className="space-y-2">
          <div className="relative overflow-hidden rounded-lg border-2 border-dashed border-[var(--cf-border-strong)] bg-white" style={{ touchAction: "none" }}>
            <canvas
              ref={canvas}
              width={700}
              height={160}
              aria-label="Signature pad"
              className="w-full cursor-crosshair"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerLeave={up}
            />
            {!hasInk && <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--cf-text-muted)]">Sign here</p>}
          </div>
          {hasInk && (
            <button type="button" onClick={clear} className="flex items-center gap-1.5 text-xs text-[var(--cf-text-secondary)]">
              <RotateCcw className="h-3.5 w-3.5" />Clear signature
            </button>
          )}
        </div>
      ) : (
        <input
          type="text"
          value={typed}
          aria-label="Type your full name"
          placeholder="Your full name"
          onChange={(e) => {
            setTyped(e.target.value)
            onChange(e.target.value.trim().length >= 3 ? e.target.value.trim() : null)
          }}
          className="w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 font-serif text-xl italic text-[var(--cf-text)] focus:outline-none focus:ring-2 focus:ring-[var(--cf-brand)]"
        />
      )}
    </div>
  )
}
