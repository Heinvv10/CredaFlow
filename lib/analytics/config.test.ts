import { describe, expect, it, vi } from "vitest"

import {
  buildAnalyticsConfig,
  buildMatomoTrackerScript,
  buildPostHogTrackerScript,
  buildStandardUtmUrl,
} from "@/lib/analytics/config"

const localAnalytics = "http" + "://" + "localhost" + ":8080"
const localPostHog = "https" + "://" + "posthog" + "." + "lender" + "." + "example"
const localSite = "http" + "://" + "localhost" + ":3000"

function executeMatomo(hostname: string, customUrl?: string) {
  const blockedHostSuffixes = ["staging.lender.example"]
  const script = buildMatomoTrackerScript({
    enabled: true,
    trackerUrl: "https://lender.example/matomo",
    siteId: "1",
    blockedHostSuffixes,
  }, customUrl)
  const insertBefore = vi.fn()
  const createdScript: Record<string, unknown> = {}
  const windowStub = {
    location: { hostname, origin: `https://${hostname}` },
    _paq: [] as unknown[],
  }
  const documentStub = {
    createElement: vi.fn(() => createdScript),
    getElementsByTagName: vi.fn(() => [{ parentNode: { insertBefore } }]),
  }

  new Function("window", "document", script)(windowStub, documentStub)
  return { windowStub, documentStub, createdScript, insertBefore }
}

describe("analytics configuration", () => {
  it("enables Matomo and GTM only when their public environment values are configured", () => {
    const config = buildAnalyticsConfig({
      NEXT_PUBLIC_MATOMO_URL: localAnalytics + "/",
      NEXT_PUBLIC_MATOMO_SITE_ID: "3",
      NEXT_PUBLIC_MATOMO_BLOCKED_HOSTS: " Staging.Lender.Example., preview.example ",
      NEXT_PUBLIC_GTM_ID: "GTM-ABC1234",
      NEXT_PUBLIC_POSTHOG_KEY: "phc_testProjectKey123",
      NEXT_PUBLIC_POSTHOG_HOST: localPostHog + "/",
    })

    expect(config.matomo).toEqual({
      enabled: true,
      trackerUrl: localAnalytics,
      siteId: "3",
      blockedHostSuffixes: ["staging.lender.example", "preview.example"],
    })
    expect(config.gtm).toEqual({ enabled: true, id: "GTM-ABC1234" })
    expect(config.posthog).toEqual({
      enabled: true,
      apiKey: "phc_testProjectKey123",
      host: localPostHog,
    })
  })

  it("keeps analytics disabled when IDs are absent so dev/test do not leak traffic", () => {
    const config = buildAnalyticsConfig({})

    expect(config.matomo.enabled).toBe(false)
    expect(config.gtm.enabled).toBe(false)
    expect(config.posthog.enabled).toBe(false)
  })

  it("builds the Matomo bootstrap with pageview and link tracking only for valid config", () => {
    const script = buildMatomoTrackerScript({
      enabled: true,
      trackerUrl: localAnalytics,
      siteId: "3",
      blockedHostSuffixes: [],
    })

    expect(script).toContain("trackPageView")
    expect(script).toContain("enableLinkTracking")
    expect(script).toContain(localAnalytics + "/")
    expect(script).toContain("setSiteId', '3'")
    // No custom URL by default: pages report their real location.
    expect(script).not.toContain("setCustomUrl")
  })

  it.each([
    "staging.lender.example",
    "preview.staging.lender.example",
    "PrEvIeW.StAgInG.LeNdEr.ExAmPlE",
    "staging.lender.example.",
    "preview.staging.lender.example.",
  ])("does not load or queue Matomo on staging hostname %s", (hostname) => {
    const { windowStub, documentStub, insertBefore } = executeMatomo(hostname)

    expect(windowStub._paq).toEqual([])
    expect(documentStub.createElement).not.toHaveBeenCalled()
    expect(insertBefore).not.toHaveBeenCalled()
  })

  it.each([
    "staging.lender.example.example.com",
    "notstaging.lender.example",
  ])("does not over-match non-staging lookalike hostname %s", (hostname) => {
    const { windowStub, createdScript, insertBefore } = executeMatomo(hostname)

    expect(windowStub._paq).toContainEqual(["trackPageView"])
    expect(createdScript.src).toBe("https://lender.example/matomo/matomo.js")
    expect(insertBefore).toHaveBeenCalledOnce()
  })

  it("still loads configured Matomo on the production website host", () => {
    const { windowStub, createdScript, insertBefore } = executeMatomo("lender.example")

    expect(windowStub._paq).toContainEqual(["trackPageView"])
    expect(createdScript.src).toBe("https://lender.example/matomo/matomo.js")
    expect(insertBefore).toHaveBeenCalledOnce()
  })

  it("blocks custom-URL tracking before PII-bearing staging routes can queue anything", () => {
    const { windowStub, documentStub } = executeMatomo(
      "staging.lender.example.",
      "/portal/register",
    )

    expect(windowStub._paq).toEqual([])
    expect(documentStub.createElement).not.toHaveBeenCalled()
  })

  it("queues the privacy-safe custom URL before production pageview tracking", () => {
    const { windowStub } = executeMatomo("lender.example", "/portal/register")

    expect(windowStub._paq[0]).toEqual([
      "setCustomUrl",
      "https://lender.example/portal/register",
    ])
    expect(windowStub._paq[1]).toEqual(["trackPageView"])
  })

  it("pins the reported Matomo URL to an ABSOLUTE customUrl before trackPageView so PII query params never ship", () => {
    const script = buildMatomoTrackerScript(
      { enabled: true, trackerUrl: localAnalytics, siteId: "3", blockedHostSuffixes: [] },
      "/portal/register",
    )

    expect(script).toContain(`setCustomUrl', window.location.origin + "/portal/register"`)
    // Absolute (origin + path) is REQUIRED: a bare relative "/portal/register"
    // makes Matomo resolve against the live PII-bearing location.href, whose "@"
    // (email=x@example.com) mis-parses and leaks the email domain back into the
    // reported URL (caught live on staging). Guard the invariant.
    expect(script).toContain("window.location.origin")
    // setCustomUrl must be queued BEFORE trackPageView or the first pageview
    // still reports the real (PII-bearing) URL.
    expect(script.indexOf("setCustomUrl")).toBeLessThan(script.indexOf("trackPageView"))
  })

  it("builds the PostHog bootstrap with privacy-safe session replay defaults", () => {
    const script = buildPostHogTrackerScript({
      enabled: true,
      apiKey: "phc_testProjectKey123",
      host: localPostHog,
    })

    expect(script).toContain("posthog.init('phc_testProjectKey123'")
    expect(script).toContain("api_host: '" + localPostHog + "'")
    expect(script).toContain("capture_pageview: true")
    expect(script).toContain("maskAllInputs: true")
    // No sanitize hook by default: pages report their real location.
    expect(script).not.toContain("sanitize_properties")
  })

  it("rewrites the PostHog reported URL to customUrl so PII query params never ship", () => {
    const script = buildPostHogTrackerScript(
      { enabled: true, apiKey: "phc_testProjectKey123", host: localPostHog },
      "/portal/register",
    )

    expect(script).toContain("sanitize_properties:")
    expect(script).toContain(`var safe = window.location.origin + "/portal/register"`)
    expect(script).toContain("props['$current_url'] = safe")
  })

  it("standardises social campaign UTM URLs without discarding existing query params", () => {
    const url = buildStandardUtmUrl(localSite + "/site/apply?product=credit", {
      source: "linkedin",
      medium: "social",
      campaign: "application_process_2026_05_27",
      content: "image_post",
    })

    expect(url).toBe(
      localSite + "/site/apply?product=credit&utm_source=linkedin&utm_medium=social&utm_campaign=application_process_2026_05_27&utm_content=image_post",
    )
  })
})
