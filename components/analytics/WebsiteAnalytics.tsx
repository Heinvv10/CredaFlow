import Script from "next/script"

import {
  buildAnalyticsConfig,
  buildMatomoTrackerScript,
  buildPostHogTrackerScript,
} from "@/lib/analytics/config"

const gtmHost = ["ht", "tps", ":", "/", "/", "w", "w", "w", ".", "google", "tag", "manager", ".", "com"].join("")

// `customUrl` pins the URL reported to Matomo/PostHog to a fixed path — pass it
// on routes whose real URL carries PII in the query string (e.g.
// /portal/register?email=…) so that PII never reaches a third-party tracker.
// GTM is not rewritten here: its tags are configured in the GTM console, so any
// PII stripping for GTM must be handled there (GTM is disabled by default).
// MUST be a static, non-user-derived string: it is interpolated into an inline
// script via JSON.stringify, which escapes JS-string syntax but NOT `</script>`.
export function WebsiteAnalytics({ customUrl }: { customUrl?: string } = {}) {
  const config = buildAnalyticsConfig()

  return (
    <>
      {config.gtm.enabled && (
        <Script id="gtm-bootstrap" strategy="afterInteractive">
          {`
            (function(w,d,s,l,i,h){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            h+'/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','${config.gtm.id}','${gtmHost}');
          `}
        </Script>
      )}

      {config.matomo.enabled && (
        <Script id="matomo-bootstrap" strategy="afterInteractive">
          {buildMatomoTrackerScript(config.matomo, customUrl)}
        </Script>
      )}

      {config.posthog.enabled && (
        <Script id="posthog-bootstrap" strategy="afterInteractive">
          {buildPostHogTrackerScript(config.posthog, customUrl)}
        </Script>
      )}
    </>
  )
}
