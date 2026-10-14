import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import net from "node:net"
import type { LookupAddress } from "node:dns"
import { assertWebhookUrl, isBlockedAddress, SsrfError, type Resolver } from "./ssrf"
import { postWebhook } from "./post"

const PUBLIC = "93.184.215.14"

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:7f00:0001::1",
    "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true))

  it.each([PUBLIC, "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false)
  })
})

const answers = (...ips: string[]): LookupAddress[] => ips.map((address) => ({ address, family: net.isIP(address) }))

describe("assertWebhookUrl", () => {
  it("accepts an https URL whose every address is public", async () => {
    const url = await assertWebhookUrl("https://hooks.example.com/cf", async () => answers(PUBLIC))
    expect(url.hostname).toBe("hooks.example.com")
  })

  it.each([
    ["http://hooks.example.com/x", /https/],
    ["https://user:pw@hooks.example.com/x", /credentials/],
    ["https://127.0.0.1/x", /not a public address/],
    ["https://[::1]/x", /not a public address/],
    ["https://169.254.169.254/latest/meta-data", /not a public address/],
    ["not a url", /valid URL/],
  ])("refuses %s", async (raw, message) => {
    await expect(assertWebhookUrl(raw, async () => answers(PUBLIC))).rejects.toThrow(message)
  })

  it("refuses a name with any private answer, and one that does not resolve", async () => {
    await expect(assertWebhookUrl("https://mixed.example.com/", async () => answers(PUBLIC, "10.0.0.5"))).rejects.toThrow(SsrfError)
    await expect(assertWebhookUrl("https://gone.example.com/", async () => { throw new Error("ENOTFOUND") })).rejects.toThrow(/does not resolve/)
  })
})

// A plain TCP listener on loopback stands in for an internal service: if the
// webhook POST ever dials it, `connections` goes up.
let server: net.Server
let port = 0
let connections = 0
beforeAll(async () => {
  server = net.createServer((socket) => { connections++; socket.destroy() })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as net.AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe("postWebhook never dials a blocked address", () => {
  it("refuses an IP-literal URL before connecting", async () => {
    connections = 0
    const result = await postWebhook(`https://127.0.0.1:${port}/hook`, "{}", {})
    expect(result).toMatchObject({ ok: false, status: null })
    expect(result.error).toMatch(/not a public address/)
    expect(connections).toBe(0)
  })

  it("checks the address inside the connection's own lookup", async () => {
    connections = 0
    const resolve = vi.fn<Resolver>(async () => answers("127.0.0.1"))
    const result = await postWebhook(`https://internal.example.test:${port}/hook`, "{}", {}, { resolve })
    expect(resolve).toHaveBeenCalledWith("internal.example.test")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a public address/)
    expect(connections).toBe(0)
  })

  it("DNS rebinding: a name that was public when saved and private when dialled is refused", async () => {
    connections = 0
    let calls = 0
    const rebinding: Resolver = async () => (++calls === 1 ? answers(PUBLIC) : answers("127.0.0.1"))
    const url = `https://rebind.example.test:${port}/hook`
    await expect(assertWebhookUrl(url, rebinding)).resolves.toBeInstanceOf(URL)
    const result = await postWebhook(url, "{}", {}, { resolve: rebinding })
    expect(calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/127\.0\.0\.1.*not a public address/)
    expect(connections).toBe(0)
  })

  it("refuses an http URL outright", async () => {
    expect((await postWebhook(`http://example.test:${port}/`, "{}", {})).error).toMatch(/https/)
  })
})
