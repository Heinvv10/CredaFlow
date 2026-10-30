import { describe, expect, it } from "vitest"
import { limiterAddress } from "./limiter-address"

describe("limiterAddress", () => {
  it("keeps an IPv4 address whole", () => {
    expect(limiterAddress("203.0.113.9")).toBe("203.0.113.9")
  })

  it.each([
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ])("buckets the IPv6 address %s to its /64", (ip, bucket) => {
    expect(limiterAddress(ip)).toBe(bucket)
  })

  it("puts every address of one /64 in one bucket, and another /64 in another", () => {
    const a = limiterAddress("2001:db8:1:2:1111:2222:3333:4444")
    expect(limiterAddress("2001:db8:1:2:ffff::9")).toBe(a)
    expect(limiterAddress("2001:db8:1:3:1111:2222:3333:4444")).not.toBe(a)
  })

  it("reads an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    expect(limiterAddress("::ffff:203.0.113.9")).toBe("203.0.113.9")
    expect(limiterAddress("::ffff:cb00:7109")).toBe("203.0.113.9")
  })

  it("leaves what is not an address alone", () => {
    expect(limiterAddress("unknown")).toBe("unknown")
    expect(limiterAddress("")).toBe("")
  })
})
