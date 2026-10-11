export type AnalyticsEnv = Partial<Record<string, string | undefined>>

export type MatomoConfig =
  | {
      enabled: true
      trackerUrl: string
      siteId: string
      blockedHostSuffixes: string[]
    }
  | {
      enabled: false
      trackerUrl?: undefined
      siteId?: undefined
      blockedHostSuffixes?: undefined
    }

export type GtmConfig =
  | {
      enabled: true
      id: string
    }
  | {
      enabled: false
      id?: undefined
    }

export type PostHogConfig =
  | {
      enabled: true
      apiKey: string
      host: string
    }
  | {
      enabled: false
      apiKey?: undefined
      host?: undefined
    }

export type AnalyticsConfig = {
  matomo: MatomoConfig
  gtm: GtmConfig
  posthog: PostHogConfig
}

export type UtmParams = {
  source: string
  medium: string
  campaign: string
  content?: string
  term?: string
}

// Analytics credentials are public build-time values. A non-production image
// can therefore retain production values if it is rebuilt from a contaminated
// Docker cache or box-local Compose environment. Keep the environment boundary
// in the browser as a final fail-closed control: these hosts must never load a
// configured production tracker. The hosts come from
// NEXT_PUBLIC_MATOMO_BLOCKED_HOSTS (comma-separated); none are assumed.
function parseBlockedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.+$/, ""))
    .filter(Boolean)
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeTrackerUrl(value: string): string {
  return value.replace(/\/+$/, "")
}

function isValidGtmId(value: string): boolean {
  return /^GTM-[A-Z0-9]+$/i.test(value)
}

function isValidPostHogKey(value: string): boolean {
  return /^phc_[A-Za-z0-9_-]+$/.test(value)
}

export function buildAnalyticsConfig(env: AnalyticsEnv = process.env): AnalyticsConfig {
  const matomoUrl = present(env.NEXT_PUBLIC_MATOMO_URL)
  const matomoSiteId = present(env.NEXT_PUBLIC_MATOMO_SITE_ID)
  const gtmId = present(env.NEXT_PUBLIC_GTM_ID)
  const posthogKey = present(env.NEXT_PUBLIC_POSTHOG_KEY)
  const posthogHost = present(env.NEXT_PUBLIC_POSTHOG_HOST)

  return {
    matomo:
      matomoUrl && matomoSiteId
        ? {
            enabled: true,
            trackerUrl: normalizeTrackerUrl(matomoUrl),
            siteId: matomoSiteId,
            blockedHostSuffixes: parseBlockedHosts(env.NEXT_PUBLIC_MATOMO_BLOCKED_HOSTS),
          }
        : { enabled: false },
    gtm:
      gtmId && isValidGtmId(gtmId)
        ? {
            enabled: true,
            id: gtmId,
          }
        : { enabled: false },
    posthog:
      posthogKey && posthogHost && isValidPostHogKey(posthogKey)
        ? {
            enabled: true,
            apiKey: posthogKey,
            host: normalizeTrackerUrl(posthogHost),
          }
        : { enabled: false },
  }
}

// `customUrl` is a PATH (e.g. "/portal/register"). When supplied it pins the URL
// Matomo reports (pageview + events + link tracking) to `origin + path` via
// setCustomUrl — queued BEFORE trackPageView so it takes effect immediately. Use
// it on routes whose real URL carries PII in the query string (e.g.
// /portal/register?email=…) so that PII never reaches Matomo.
//
// MUST be an ABSOLUTE URL. setCustomUrl resolves a RELATIVE value against the
// live location.href, and Matomo's host parser mis-reads an "@" in the query
// (email=x@example.com → host "example.com") — so a bare "/portal/register"
// leaks the email domain + other query params back into the reported URL.
// Concatenating window.location.origin sidesteps all
// of Matomo's URL re-parsing. JSON.stringify keeps the path a safe JS literal.
export function buildMatomoTrackerScript(config: MatomoConfig, customUrl?: string): string {
  if (!config.enabled) return ""

  const trackerUrl = `${config.trackerUrl}/`
  const blockedHostSuffixes = JSON.stringify(config.blockedHostSuffixes)
  const setCustomUrl = customUrl
    ? `_paq.push(['setCustomUrl', window.location.origin + ${JSON.stringify(customUrl)}]);\n    `
    : ""

  return `
    (function() {
    var h = window.location.hostname.toLowerCase().replace(/\\.+$/, '');
    var blocked = ${blockedHostSuffixes};
    for (var i = 0; i < blocked.length; i++) {
      if (h === blocked[i] || h.endsWith('.' + blocked[i])) return;
    }
    var _paq = window._paq = window._paq || [];
    ${setCustomUrl}_paq.push(['trackPageView']);
    _paq.push(['enableLinkTracking']);
    (function() {
      var u='${trackerUrl}';
      _paq.push(['setTrackerUrl', u+'matomo.php']);
      _paq.push(['setSiteId', '${config.siteId}']);
      var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
      g.async=true; g.src=u+'matomo.js'; s.parentNode.insertBefore(g,s);
    })();
    })();
  `
}

// `customUrl` mirrors buildMatomoTrackerScript: on PII-bearing routes it rewrites
// the URL PostHog reports (pageview + autocapture) to a fixed path via a
// sanitize_properties hook, so the query string (e.g. ?email=…) never leaves the
// browser. PostHog is disabled by default; this keeps the route safe if it's
// later enabled.
export function buildPostHogTrackerScript(config: PostHogConfig, customUrl?: string): string {
  if (!config.enabled) return ""

  const sanitize = customUrl
    ? `sanitize_properties: function (props) {
        var safe = window.location.origin + ${JSON.stringify(customUrl)};
        if (props['$current_url']) props['$current_url'] = safe;
        if (props['$pathname']) props['$pathname'] = ${JSON.stringify(customUrl)};
        return props;
      },`
    : ""

  return `
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags reloadFeatureFlags group getFeatureFlag getFeatureFlagPayload trackPageView".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    posthog.init('${config.apiKey}', {
      api_host: '${config.host}',
      person_profiles: 'identified_only',
      capture_pageview: true,
      autocapture: true,
      ${sanitize}
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-private], [data-sensitive]'
      }
    });
  `
}

export function buildStandardUtmUrl(rawUrl: string, params: UtmParams): string {
  const url = new URL(rawUrl)

  url.searchParams.set("utm_source", params.source)
  url.searchParams.set("utm_medium", params.medium)
  url.searchParams.set("utm_campaign", params.campaign)

  if (params.content) {
    url.searchParams.set("utm_content", params.content)
  }

  if (params.term) {
    url.searchParams.set("utm_term", params.term)
  }

  return url.toString()
}
