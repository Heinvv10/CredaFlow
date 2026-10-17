import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { allLessons, lessonAssets } from "./curriculum"
import { availableLessonMedia } from "./media"
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
describe("release lesson media", () => {
  it("does not advertise any absent asset across the curriculum in a clean release", async () => {
    for (const lesson of allLessons()) {
      const media = await availableLessonMedia(lesson.slug)
      const declared = lessonAssets(lesson.slug)
      for (const key of ["video", "poster"] as const) {
        if (media[key]) {
          expect(media[key]).toBe(declared[key])
          expect((await stat(path.join(process.cwd(), "public", media[key]))).isFile()).toBe(true)
        }
        else expect(media[key]).toBeNull()
      }
    }
  })
  it("detects packaged files independently, using an explicit standalone public root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gtm-b-media-")); dirs.push(root)
    await mkdir(path.join(root, "admin-manual/videos"), { recursive: true })
    await writeFile(path.join(root, "admin-manual/videos/synthetic.mp4"), "synthetic fixture")
    expect(await availableLessonMedia("synthetic", root)).toEqual({ video: "/admin-manual/videos/synthetic.mp4", poster: null })
  })
})
