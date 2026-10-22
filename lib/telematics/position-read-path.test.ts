import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ROOT, sourceFiles } from "./__fixtures__/import-graph"

// A coordinate has one read path (docs/asset-finance/SLICE5.md part B, POPIA):
// position-view.ts, which logs every reveal. Only three modules may touch the
// TelematicsPosition table or select a latitude/longitude: the ingest writer,
// the purge and the view. No page queries it: a position is never rendered
// with a page, so a READONLY page load can never materialise one. A client
// component cannot query: it only shows what that route answered.
const ALLOWED = ["lib/telematics/ingest.ts", "lib/telematics/purge.ts", "lib/telematics/position-view.ts"]
// `position` / `positions`: the relation from an event or a device (an include or a select of it reads the row).
const TOUCHES_TABLE = /telematicsPosition\.|(FROM|INTO|JOIN|UPDATE|TRUNCATE)\s+"TelematicsPosition"|\bpositions?:\s*(true|\{)/
const SELECTS_COORDINATE = /\b(latitude|longitude):\s*true\b|"latitude"|"longitude"/

describe("the last known position has one read path", () => {
  const files = ["lib", "app", "components"].flatMap((dir) => sourceFiles(dir))
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8")

  it("catches every way a module could read a position", () => {
    for (const attempt of [
      "prisma.trackerDevice.findMany({ include: { positions: true } })",
      "prisma.trackerDevice.findFirst({ select: { position: { select: { occurredAt: true } } } })",
      "prisma.telematicsEvent.findMany({ include: { position: true } })",
      "tx.telematicsPosition.findFirst({ where: { tenantId } })",
      'SELECT * FROM "TelematicsPosition"',
    ]) expect(TOUCHES_TABLE.test(attempt), attempt).toBe(true)
    expect(SELECTS_COORDINATE.test("select: { latitude: true }")).toBe(true)
    expect(TOUCHES_TABLE.test("position?: { latitude: number }")).toBe(false)
  })

  it("scans the application sources", () => {
    for (const file of ALLOWED) expect(files).toContain(file)
    expect(files.length).toBeGreaterThan(500)
  })

  it("lets only the writer, the purge and the logged view touch positions or select a coordinate", () => {
    const server = files.filter((file) => !/^["']use client["']/.test(read(file)))
    expect(server).toContain("lib/telematics/position-view.ts")
    expect(files.length - server.length).toBeGreaterThan(50)
    const offenders = server.filter((file) => !ALLOWED.includes(file) && (TOUCHES_TABLE.test(read(file)) || SELECTS_COORDINATE.test(read(file))))
    expect(offenders).toEqual([])
  })

  it("has no page that queries a position", () => {
    const pages = files.filter((file) => /\/page\.tsx$/.test(file))
    expect(pages.length).toBeGreaterThan(50)
    expect(pages.filter((file) => /telematicsPosition\.|"TelematicsPosition"|revealPosition|position-view/.test(read(file)))).toEqual([])
  })
})
