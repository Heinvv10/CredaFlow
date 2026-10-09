import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8")

describe("production image public assets", () => {
  it("copies public content for the non-root Next.js runtime user", () => {
    expect(dockerfile).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/public ./public",
    )
    expect(dockerfile.indexOf("--chown=nextjs:nodejs /app/public")).toBeLessThan(
      dockerfile.indexOf("USER nextjs"),
    )
  })
})
