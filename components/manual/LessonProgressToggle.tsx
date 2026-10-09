"use client"

import { useState, useTransition } from "react"
import { CheckCircle2, Circle } from "lucide-react"
import { toggleLesson } from "@/app/(dashboard)/learn/actions"

type Props = { lessonSlug: string; initialComplete: boolean }

export function LessonProgressToggle({ lessonSlug, initialComplete }: Props) {
  const [complete, setComplete] = useState(initialComplete)
  const [pending, startTransition] = useTransition()

  function onClick() {
    const next = !complete
    setComplete(next)
    startTransition(async () => {
      try {
        await toggleLesson(lessonSlug, next)
      } catch {
        setComplete(!next) // revert on failure
      }
    })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={complete}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        complete ? "bg-emerald-600 text-white" : "border border-[var(--cf-border-subtle)] hover:border-[var(--cf-brand-alt)]"
      }`}
    >
      {complete ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <Circle className="h-4 w-4" aria-hidden="true" />}
      {complete ? "Completed" : "Mark complete"}
    </button>
  )
}
