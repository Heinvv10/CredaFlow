import { stat } from "node:fs/promises"
import path from "node:path"
import { lessonAssets } from "./curriculum"

/** Server-side check against the release's public directory, also used in standalone builds. */
export async function availableLessonMedia(slug: string, publicRoot = path.join(process.cwd(), "public")) {
  const declared = lessonAssets(slug)
  const available = async (url: string) => {
    try { return (await stat(path.join(publicRoot, url))).isFile() ? url : null } catch { return null }
  }
  const [video, poster] = await Promise.all([available(declared.video), available(declared.poster)])
  return { video, poster }
}
