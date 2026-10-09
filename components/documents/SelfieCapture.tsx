"use client"

import { useRef, useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Camera, RotateCcw, Check, AlertCircle } from "lucide-react"

interface Props {
  onCapture: (file: File) => void
  disabled?: boolean
}

export function SelfieCapture({ onCapture, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [phase, setPhase] = useState<"idle" | "camera" | "preview" | "error">("idle")
  const [error, setError] = useState("")
  const [previewUrl, setPreviewUrl] = useState("")

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  useEffect(() => () => stopStream(), [stopStream])

  const openCamera = async () => {
    setError("")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      setPhase("camera")
      // Wait for DOM to render video element before attaching stream
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
      }, 100)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("Permission") || msg.includes("denied")) {
        setError("Camera access denied. Please allow camera access in your browser settings.")
      } else if (msg.includes("NotFound") || msg.includes("Requested device not found")) {
        setError("No camera found on this device.")
      } else {
        setError("Could not access camera. " + msg)
      }
      setPhase("error")
    }
  }

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Mirror the image (front camera is mirrored in video, un-mirror for capture)
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    stopStream()
    const url = canvas.toDataURL("image/jpeg", 0.92)
    setPreviewUrl(url)
    setPhase("preview")
    // Convert to File
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: "image/jpeg" })
        onCapture(file)
      }
    }, "image/jpeg", 0.92)
  }

  const retake = () => {
    setPreviewUrl("")
    setPhase("idle")
    openCamera()
  }

  const reset = () => {
    stopStream()
    setPreviewUrl("")
    setPhase("idle")
    setError("")
  }

  return (
    <div className="space-y-3">
      <canvas ref={canvasRef} className="hidden" />

      {phase === "idle" && (
        <div className="border-2 border-dashed rounded-lg p-8 text-center">
          <Camera className="h-10 w-10 text-gray-400 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-700">Take a selfie</p>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Your camera will open — no file upload allowed
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={openCamera}
            disabled={disabled}
          >
            <Camera className="h-4 w-4 mr-2" />
            Open Camera
          </Button>
        </div>
      )}

      {phase === "camera" && (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
              style={{ transform: "scaleX(-1)" }}
              onLoadedMetadata={(e) => (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
            />
            {/* Face guide overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="border-4 border-white/60 rounded-full w-40 h-48 opacity-60" />
            </div>
          </div>
          <p className="text-xs text-center text-gray-500">
            Position your face in the oval · Look directly at camera
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={reset} className="flex-1">
              <RotateCcw className="h-4 w-4 mr-2" /> Cancel
            </Button>
            <Button type="button" onClick={capture} className="flex-1">
              <Camera className="h-4 w-4 mr-2" /> Take Photo
            </Button>
          </div>
        </div>
      )}

      {phase === "preview" && (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden aspect-video bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Selfie preview" className="w-full h-full object-cover" />
            <div className="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full flex items-center gap-1">
              <Check className="h-3 w-3" /> Captured
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={retake} className="flex-1">
              <RotateCcw className="h-4 w-4 mr-2" /> Retake
            </Button>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="border-2 border-red-200 rounded-lg p-6 text-center bg-red-50">
          <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
          <p className="text-sm text-red-700 font-medium">Camera unavailable</p>
          <p className="text-xs text-red-600 mt-1">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={reset} className="mt-3">
            Try Again
          </Button>
        </div>
      )}

      <ul className="text-xs text-gray-400 space-y-0.5">
        <li>• Face the camera directly in good lighting</li>
        <li>• Remove sunglasses or hats</li>
        <li>• Photo is used for identity verification only (POPIA)</li>
      </ul>
    </div>
  )
}
