import { describe, it, expect } from "vitest"
import { curriculum, allLessons, findLesson, lessonAssets, totalLessonCount } from "./curriculum"

describe("curriculum", () => {
  it("has at least 7 modules covering the full admin surface", () => {
    expect(curriculum.length).toBeGreaterThanOrEqual(7)
  })

  it("every lesson slug is unique and url-safe", () => {
    const slugs = allLessons().map((l) => l.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/)
  })

  it("every lesson has a title, summary, at least one step, and a live route", () => {
    for (const l of allLessons()) {
      expect(l.title.length).toBeGreaterThan(0)
      expect(l.summary.length).toBeGreaterThan(0)
      expect(l.steps.length).toBeGreaterThan(0)
      expect(l.liveRoute.startsWith("/")).toBe(true)
    }
  })

  it("findLesson resolves a known slug and returns undefined otherwise", () => {
    const first = allLessons()[0]
    expect(findLesson(first.slug)?.slug).toBe(first.slug)
    expect(findLesson("does-not-exist")).toBeUndefined()
  })

  it("lessonAssets maps slug to /admin-manual paths", () => {
    expect(lessonAssets("sign-in-2fa")).toEqual({
      video: "/admin-manual/videos/sign-in-2fa.mp4",
      poster: "/admin-manual/screenshots/sign-in-2fa.png",
    })
  })

  it("totalLessonCount equals the flattened lesson count", () => {
    expect(totalLessonCount()).toBe(allLessons().length)
  })
})
