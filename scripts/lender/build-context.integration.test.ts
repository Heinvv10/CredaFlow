/**
 * Real-docker proof that a lender build ships tracked files only: gitignored canaries
 * (a .env file, a .pem, uploads/, the OCR corpus of real client documents) are
 * planted in this checkout, both images are built with lib.sh's build_images, and
 * neither image may contain any of them. Slow (a full image build), so opt-in.
 *
 *   RUN_DOCKER_BUILD_IT=1 npx vitest run scripts/lender/build-context.integration.test.ts
 *
 * Needs a clean tree (build_images refuses a dirty one); the canaries are gitignored.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const suite = process.env.RUN_DOCKER_BUILD_IT === "1" ? describe : describe.skip
const REPO = join(__dirname, "../..")
const TAG = `canary-${process.pid}`
const IMAGE = `credaflow-lender-canary-it:${TAG}`
const TOOLS = `credaflow-lender-canary-it-tools:${TAG}`
const CREATED: string[] = []
const CANARIES = [".env.canary-it", "canary-it.pem", "uploads/canary-it.txt", "lib/ocr/accuracy/corpus/canary-it.pdf"]

suite("lender build context (real docker)", () => {
  afterAll(() => {
    for (const f of CANARIES) rmSync(join(REPO, f), { force: true })
    // Remove only directories this test created, and only if now empty (never a real uploads/ or corpus).
    for (const d of CREATED) {
      try {
        rmdirSync(d)
      } catch {
        /* not empty or already gone: leave it */
      }
    }
    spawnSync("docker", ["rmi", IMAGE, TOOLS])
  })

  it("contains none of the gitignored canaries in the runtime image or the tools image", { timeout: 1_800_000 }, () => {
    for (const dir of ["uploads", "lib/ocr/accuracy/corpus"]) {
      const made = mkdirSync(join(REPO, dir), { recursive: true })
      if (made) CREATED.unshift(join(REPO, dir))
    }
    for (const f of CANARIES) writeFileSync(join(REPO, f), "CANARY-DO-NOT-SHIP")

    const build = spawnSync("bash", ["-c", `. scripts/lender/lib.sh; SLUG=canary-it; ENV_FILE=/dev/null; build_images ${IMAGE} ${TOOLS}`], { cwd: REPO, encoding: "utf8" })
    expect(build.status, build.stderr.slice(-2000)).toBe(0)

    for (const image of [IMAGE, TOOLS]) {
      const found = spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", "find / -xdev \\( -name '*canary-it*' -o -name '.env.production' \\) 2>/dev/null; grep -rl CANARY-DO-NOT-SHIP /app 2>/dev/null | head"], { encoding: "utf8" })
      expect(found.stdout.trim(), `${image} contains: ${found.stdout}`).toBe("")
    }
  })
})
