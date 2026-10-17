import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadPinnedFile } from "./fetch-face-models-download"

const bytes = Buffer.from("abcdefghij")
const digest = createHash("sha256").update(bytes).digest("hex")
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-model-download-")); dirs.push(dir)
  return { target: path.join(dir, "model.onnx"), model: { url: "https://official.invalid/model", sha256: digest } }
}
function range(start: number, end: number, total = bytes.length, body = bytes.subarray(start, end + 1)) {
  return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(body.length) } })
}
describe("pinned model acquisition", () => {
  it("assembles sequential ranges with an exact final short chunk", async () => {
    const { target, model } = fixture()
    const fetcher = vi.fn().mockResolvedValueOnce(range(0, 3)).mockResolvedValueOnce(range(4, 7)).mockResolvedValueOnce(range(8, 9))
    expect(await downloadPinnedFile(target, model, fetcher, 4)).toBe(10)
    expect(fetcher.mock.calls.map(([, init]) => init.headers.Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-9"])
    expect(readFileSync(target)).toEqual(bytes)
    expect(existsSync(target + ".partial")).toBe(false)
  })
  it("accepts a server ignoring Range with one complete verified200 response", async () => {
    const { target, model } = fixture(); const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "Content-Length": "10" } }))
    await downloadPinnedFile(target, model, fetcher, 4)
    expect(fetcher).toHaveBeenCalledTimes(1); expect(readFileSync(target)).toEqual(bytes)
  })
  it.each([
    ["wrong start", () => range(1, 3)],
    ["wrong end", () => range(0, 2)],
    ["invalid total", () => range(0, 3, 0)],
    ["missing range", () => new Response(bytes.subarray(0, 4), { status: 206 })],
    ["truncated body", () => range(0, 3, 10, bytes.subarray(0, 3))],
    ["terminated body", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("terminated")) } }), { status: 206, headers: { "Content-Range": "bytes 0-3/10" } })],
  ])("rejects %s and removes partial bytes without replacing existing target", async (_name, response) => {
    const { target, model } = fixture(); writeFileSync(target, "old")
    const fetcher = vi.fn().mockImplementation(async () => response())
    await expect(downloadPinnedFile(target, model, fetcher, 4)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(_name === "terminated body" ? 3 : 1)
    expect(existsSync(target + ".partial")).toBe(false); expect(readFileSync(target, "utf8")).toBe("old")
  })
  it.each([
    ["total changes", () => range(4, 7, 11)],
    ["full body after accumulation", () => new Response(bytes)],
    ["terminated later body", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("terminated")) } }), { status: 206, headers: { "Content-Range": "bytes 4-7/10" } })],
  ])("rejects %s after the first chunk", async (_name, response) => {
    const { target, model } = fixture(); const fetcher = vi.fn().mockResolvedValueOnce(range(0, 3)).mockResolvedValueOnce(response())
    await expect(downloadPinnedFile(target, model, fetcher, 4)).rejects.toThrow()
    expect(existsSync(target)).toBe(false); expect(existsSync(target + ".partial")).toBe(false)
  })
  it("rejects truncated200 fallback and HTTP failure", async () => {
    for (const response of [new Response(bytes, { headers: { "Content-Length": "11" } }), new Response("failed", { status: 503 })]) {
      const { target, model } = fixture()
      await expect(downloadPinnedFile(target, model, vi.fn().mockResolvedValue(response), 4)).rejects.toThrow()
      expect(existsSync(target)).toBe(false); expect(existsSync(target + ".partial")).toBe(false)
    }
  })
  it("retries transport failure at the same offset without corrupting assembly", async () => {
    const { target, model } = fixture()
    const fetcher = vi.fn().mockResolvedValueOnce(range(0, 3)).mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(range(4, 7)).mockResolvedValueOnce(range(8, 9))
    await downloadPinnedFile(target, model, fetcher, 4)
    expect(fetcher.mock.calls.map(([, init]) => init.headers.Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=4-7", "bytes=8-9"])
    expect(readFileSync(target)).toEqual(bytes)
  })
  it("retries a terminated chunk body without hashing or appending its bytes", async () => {
    const { target, model } = fixture()
    const terminated = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(4, 6)); controller.error(new TypeError("terminated")) } }), { status: 206, headers: { "Content-Range": "bytes 4-7/10" } })
    const fetcher = vi.fn().mockResolvedValueOnce(range(0, 3)).mockResolvedValueOnce(terminated)
      .mockResolvedValueOnce(range(4, 7)).mockResolvedValueOnce(range(8, 9))
    await downloadPinnedFile(target, model, fetcher, 4)
    expect(fetcher.mock.calls.map(([, init]) => init.headers.Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=4-7", "bytes=8-9"])
    expect(readFileSync(target)).toEqual(bytes)
  })
  it("bounds repeated transport failures and preserves existing target with no partial", async () => {
    const { target, model } = fixture(); writeFileSync(target, "old")
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"))
    await expect(downloadPinnedFile(target, model, fetcher, 4)).rejects.toThrow("fetch failed")
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(readFileSync(target, "utf8")).toBe("old"); expect(existsSync(target + ".partial")).toBe(false)
  })
  it("times out and bounds requests that never return headers", async () => {
    const { target, model } = fixture(); writeFileSync(target, "old")
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    await expect(downloadPinnedFile(target, model, fetcher, 4, 10)).rejects.toThrow("timed out")
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(readFileSync(target, "utf8")).toBe("old"); expect(existsSync(target + ".partial")).toBe(false)
  })
  it("times out stalled bodies and retries only that same incomplete chunk", async () => {
    const { target, model } = fixture()
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true }) },
    }), { status: 206, headers: { "Content-Range": "bytes 4-7/10" } }))
      .mockResolvedValueOnce(range(0, 3))
    await expect(downloadPinnedFile(target, model, fetcher, 4, 10)).rejects.toThrow("timed out")
    expect(fetcher.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=4-7", "bytes=4-7"])
    expect(existsSync(target)).toBe(false); expect(existsSync(target + ".partial")).toBe(false)
  })
  it("rejects a complete assembly with wrong pinned SHA and cleans partial", async () => {
    const { target, model } = fixture()
    await expect(downloadPinnedFile(target, { ...model, sha256: "0".repeat(64) }, vi.fn().mockResolvedValue(new Response(bytes)), 4)).rejects.toThrow(/sha256/)
    expect(existsSync(target)).toBe(false); expect(existsSync(target + ".partial")).toBe(false)
  })
})
