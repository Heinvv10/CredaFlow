"use client"

import { useState } from "react"
import Image from "next/image"

type Props = { videoSrc: string | null; posterSrc: string | null; title: string }

export function LessonPlayer({ videoSrc, posterSrc, title }: Props) {
  const [videoFailed, setVideoFailed] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)

  if (!videoSrc || videoFailed) {
    if (!posterSrc || posterFailed) {
      // Both video and poster are missing: fall back to a styled, on-brand
      // placeholder instead of a broken-image icon.
      return (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-[var(--cf-border-subtle)] text-center text-sm text-[var(--cf-text-muted)]">
          <span>
            This lesson, &ldquo;{title}&rdquo;, is available as a written guide.
            <br />
            Follow the step-by-step guide below.
          </span>
        </div>
      )
    }
    // Video missing (not yet rendered): show the poster still so the lesson
    // stays usable instead of a broken player.
    return (
      <div className="overflow-hidden rounded-xl border border-[var(--cf-border-subtle)]">
        <Image
          src={posterSrc}
          alt={`${title} preview`}
          width={1440}
          height={900}
          className="w-full h-auto"
          onError={() => setPosterFailed(true)}
        />
      </div>
    )
  }

  return (
    <video
      controls
      poster={posterSrc ?? undefined}
      onError={() => setVideoFailed(true)}
      className="w-full rounded-xl border border-[var(--cf-border-subtle)]"
    >
      <source src={videoSrc} type="video/mp4" />
    </video>
  )
}
