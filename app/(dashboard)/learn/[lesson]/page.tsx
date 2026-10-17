import { availableLessonMedia } from "@/lib/manual/media"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ExternalLink, ShieldCheck } from "lucide-react"
import { requireMinRole } from "@/lib/auth-guards"
import { auth } from "@/lib/auth"
import { Header } from "@/components/layout/Header"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { findLesson } from "@/lib/manual/curriculum"
import { getCompletedSlugs } from "@/lib/manual/progress"
import { LessonPlayer } from "@/components/manual/LessonPlayer"
import { LessonProgressToggle } from "@/components/manual/LessonProgressToggle"

export default async function LessonPage({ params }: { params: Promise<{ lesson: string }> }) {
  await requireMinRole("READONLY")
  const { lesson: slug } = await params
  const lesson = findLesson(slug)
  if (!lesson) notFound()

  const session = await auth()
  const completed = session?.user ? await getCompletedSlugs(session.user.id) : []
  const assets = await availableLessonMedia(lesson.slug)

  return (
    <>
      <Header title={lesson.title} subtitle={lesson.summary} />
      <div className="p-4 lg:p-8 space-y-6 max-w-4xl">
        <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Academy", href: "/learn" }, { label: lesson.title }]} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <LessonProgressToggle lessonSlug={lesson.slug} initialComplete={completed.includes(lesson.slug)} />
          <Link href={lesson.liveRoute} className="inline-flex items-center gap-2 text-sm text-[var(--cf-brand-alt)] hover:underline">
            Open the live screen <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        <LessonPlayer videoSrc={assets.video} posterSrc={assets.poster} title={lesson.title} />

        <section>
          <h2 className="mb-3 text-lg font-semibold">Step by step</h2>
          <ol className="space-y-2">
            {lesson.steps.map((step, i) => (
              <li key={i} className="flex gap-3 rounded-lg border border-[var(--cf-border-subtle)] p-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--cf-brand-alt)] text-sm font-semibold text-[var(--cf-on-brand)]">{i + 1}</span>
                <span>{step.caption}</span>
              </li>
            ))}
          </ol>
        </section>

        {lesson.keyRules.length > 0 && (
          <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-600"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Key rules</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {lesson.keyRules.map((rule, i) => <li key={i}>{rule}</li>)}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}
