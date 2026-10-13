import { describe, expect, it } from "vitest"
import { isImageRead } from "./static-image"

const req = (method: string, pathname: string) => ({ method, nextUrl: { pathname } })

describe("isImageRead", () => {
  it.each(["png", "jpg", "jpeg", "webp", "svg", "ico"])("answers a GET and a HEAD of a .%s path", (ext) => {
    expect(isImageRead(req("GET", `/brand/logo.${ext}`))).toBe(true)
    expect(isImageRead(req("HEAD", `/x/y.${ext}`))).toBe(true)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("never answers a %s, whatever the suffix", (method) => {
    expect(isImageRead(req(method, "/crm/leads/abc.png"))).toBe(false)
  })

  it.each(["/x/y.png/z", "/x/y.pngx", "/x/y.PNG", "/x/ypng", "/x/y.png.html", "/"])("leaves %s to the proxy", (pathname) => {
    expect(isImageRead(req("GET", pathname))).toBe(false)
  })
})
