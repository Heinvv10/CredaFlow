// app/(dashboard)/learn/page.tsx
import Link from "next/link"
import { GraduationCap, CheckCircle2 } from "lucide-react"
import { requireMinRole } from "@/lib/auth-guards"
import { auth } from "@/lib/auth"
import { Header } from "@/components/layout/Header"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { curriculum, totalLessonCount } from "@/lib/manual/curriculum"
import { getCompletedSlugs } from "@/lib/manual/progress"

export default async function AcademyHomePage() {
  await requireMinRole("READONLY")
  const session = await auth()
  const completed = new Set(session?.user ? await getCompletedSlugs(session.user.id) : [])
  const curriculumSlugs = new Set(curriculum.flatMap((m) => m.lessons.map((l) => l.slug)))
  const total = totalLessonCount()
  const done = [...completed].filter((s) => curriculumSlugs.has(s)).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)

  return (
    <>
      <Header title="Academy" subtitle="Learn the admin system at your own pace" />
      <div className="p-4 lg:p-8 space-y-8">
        <Breadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Academy" }]} />

        <section className="rounded-xl border border-[var(--cf-border-subtle)] p-6">
          <div className="flex items-center gap-3">
            <GraduationCap className="h-6 w-6 text-[var(--cf-brand-alt)]" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-sm text-[var(--cf-text-muted)]">Your progress</p>
              <p className="text-lg font-semibold">{done} of {total} lessons complete ({pct}%)</p>
            </div>
          </div>
          <div className="mt-4 h-2 w-full rounded-full bg-[var(--cf-border-subtle)]">
            <div className="h-2 rounded-full bg-[var(--cf-brand-alt)]" style={{ width: `${pct}%` }} />
          </div>
        </section>

        {curriculum.map((module) => (
          <section key={module.slug} className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">{module.title}</h2>
              <p className="text-sm text-[var(--cf-text-muted)]">{module.description}</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {module.lessons.map((lesson) => (
                <li key={lesson.slug}>
                  <Link
                    href={`/learn/${lesson.slug}`}
                    className="flex items-start gap-3 rounded-lg border border-[var(--cf-border-subtle)] p-4 hover:border-[var(--cf-brand-alt)] transition-colors"
                  >
                    <CheckCircle2 className={`mt-0.5 h-5 w-5 shrink-0 ${completed.has(lesson.slug) ? "text-emerald-500" : "text-[var(--cf-border-subtle)]"}`} aria-hidden="true" />
                    <span>
                      <span className="block font-medium">{lesson.title}</span>
                      <span className="block text-sm text-[var(--cf-text-muted)]">{lesson.summary}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
