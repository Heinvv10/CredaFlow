import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { isStaticAssetRead, PUBLIC_IMAGE_FILES } from "./static-image"

const req = (method: string, pathname: string) => ({ method, nextUrl: { pathname } })

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public")
const IMAGE = /\.(?:png|jpg|jpeg|webp|svg|ico)$/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
const onDisk = walk(PUBLIC_DIR)
  .map((f) => "/" + path.relative(PUBLIC_DIR, f).split(path.sep).join("/"))
  .filter((p) => IMAGE.test(p))
  .sort()

describe("isStaticAssetRead", () => {
  it("lists exactly the image files that exist under public/", () => {
    expect([...PUBLIC_IMAGE_FILES].sort()).toEqual(onDisk)
  })

  it.each(onDisk)("answers a GET and a HEAD of the real asset %s", (file) => {
    expect(isStaticAssetRead(req("GET", file))).toBe(true)
    expect(isStaticAssetRead(req("HEAD", file))).toBe(true)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("never answers a %s, even of a real asset", (method) => {
    expect(isStaticAssetRead(req(method, onDisk[0]))).toBe(false)
  })

  // The proxy's gates (audience, role, enrolment) must run for these, whatever
  // the suffix: a dynamic segment such as /clients/[id] takes "x.png".
  it.each([
    "/clients/x.png", "/api/clients/x.png", "/crm/leads/x.png", "/brand/logo.png", "/x/y.jpg",
    "/nested/file.svg", "/file.svg/extra", "/file.svgx", "/FILE.SVG", "/x/y.png.html", "/",
  ])("leaves %s to the proxy", (pathname) => {
    expect(isStaticAssetRead(req("GET", pathname))).toBe(false)
    expect(isStaticAssetRead(req("HEAD", pathname))).toBe(false)
  })
})
