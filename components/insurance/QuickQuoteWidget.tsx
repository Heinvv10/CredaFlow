"use client"

import Script from "next/script"
import { useCallback, useState } from "react"
import type { QuickQuoteConfig, QuickQuoteView } from "@/lib/insurance/quickquote-config"
import {
  buildQuickQuoteOptions,
  type QuickQuoteOptions,
} from "@/lib/insurance/quickquote-options"

/**
 * Mounts FSP Solutions' QuickQuote jQuery plugin.
 *
 * This component may only be rendered on the isolated quote host — never on
 * app/(website) or app/(portal). The script it loads bundles jQuery 1.9.1 and
 * evaluates FSP-authored JSONP responses, so whichever origin renders it hands
 * FSP script execution in that origin. See lib/insurance/quickquote-config.ts.
 */

const FSPQQ_SCRIPT_URL =
  "https://www.fspsolutions.com/QQ/live/Content/Handlers/fspqq.js.ashx"

type FspqqTarget = { fspqq?: (options: QuickQuoteOptions) => void }

declare global {
  interface Window {
    // Set by FSP's bundle as `window.jQuery = window.$ = b`. Typed narrowly:
    // we call exactly one plugin on exactly one selector.
    jQuery?: (selector: string) => FspqqTarget
  }
}

export function QuickQuoteWidget({
  config,
  view,
}: {
  config: QuickQuoteConfig
  view: QuickQuoteView
}) {
  const [failed, setFailed] = useState(false)

  const initialise = useCallback(() => {
    const jq = window.jQuery
    const target = jq?.("#fspqq")
    if (!target?.fspqq) {
      // The script loaded but did not register the plugin — treat as failure
      // rather than leaving the visitor at a permanent "Loading…".
      setFailed(true)
      return
    }
    target.fspqq(buildQuickQuoteOptions(config, view))
  }, [config, view])

  if (failed) {
    return (
      <p role="alert" className="px-4 py-8 text-sm text-white/72">
        The quote service is temporarily unavailable. Please try again shortly, or
        send us an enquiry and an adviser will call you back.
      </p>
    )
  }

  return (
    <>
      <div id="fspqq" />
      <Script
        src={FSPQQ_SCRIPT_URL}
        strategy="afterInteractive"
        onReady={initialise}
        onError={() => setFailed(true)}
      />
    </>
  )
}
