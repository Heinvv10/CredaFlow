import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LessonPlayer } from "./LessonPlayer"
describe("training media availability", () => {
  it("renders a deliberate written guide without requesting missing media", () => {
    const html = renderToStaticMarkup(<LessonPlayer title="Synthetic lesson" videoSrc={null} posterSrc={null} />)
    expect(html).toContain("written guide")
    expect(html).not.toContain("<video")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("admin-manual")
  })
  it("advertises only available media", () => {
    const html = renderToStaticMarkup(<LessonPlayer title="Synthetic" videoSrc="/synthetic.mp4" posterSrc={null} />)
    expect(html).toContain("/synthetic.mp4")
    expect(html).not.toContain("poster=")
  })
})
