/**
 * Real-docker proof that the production image can render a PDF: chromium is
 * launched inside the image as the image's own user (no --user, no HOME
 * override), with htmlToPdf's launch options, and page.pdf must return a
 * %PDF- buffer. Slow (a full image build), so opt-in.
 *
 *   RUN_DOCKER_BUILD_IT=1 npx vitest run lib/documents/html-to-pdf.image.integration.test.ts
 *
 * OPT-IN ONLY: scripts/run-integration-tests.sh (and so the CI integration job) does NOT
 * export RUN_DOCKER_BUILD_IT and lists this file as "opt-in, NOT run by this gate": a full
 * image build runs that job out of memory. Do not add it to the runner's export list.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

const suite = process.env.RUN_DOCKER_BUILD_IT === "1" ? describe : describe.skip
const REPO = join(__dirname, "../..")
const IMAGE = `credaflow-image-pdf-it:${process.pid}`

// htmlToPdf's launch options (./html-to-pdf.ts; keep in sync): the chromium launch is what is under test.
const RENDER = `
import("puppeteer").then(async ({ default: puppeteer }) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  })
  try {
    const page = await browser.newPage()
    await page.setContent("<h1>Synthetic</h1>", { waitUntil: "load" })
    const pdf = await page.pdf({ format: "A4", printBackground: true })
    process.stdout.write(Buffer.from(pdf).subarray(0, 5).toString("latin1"))
  } finally {
    await browser.close()
  }
})`

suite("production image renders a PDF (real docker)", () => {
  afterAll(() => {
    spawnSync("docker", ["rmi", IMAGE])
  })

  it("launches chromium as the image's user and returns a %PDF- buffer", { timeout: 1_800_000 }, () => {
    const build = spawnSync("docker", ["build", "-t", IMAGE, "."], { cwd: REPO, encoding: "utf8" })
    expect(build.status, build.stderr.slice(-2000)).toBe(0)

    const run = spawnSync("docker", ["run", "--rm", "--entrypoint", "node", IMAGE, "-e", RENDER], { encoding: "utf8", timeout: 120_000 })
    expect(run.stdout, run.stderr.slice(-2000)).toBe("%PDF-")
  })
})
