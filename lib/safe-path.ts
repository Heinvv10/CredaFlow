/**
 * A same-origin path that is safe to redirect to, or null.
 *
 * Accepts only a leading "/" followed by unreserved path characters, the same
 * allow-list as safePortalPath (lib/portal-urls.ts) without the /portal/
 * prefix. That rejects everything a browser may read as another origin: "//",
 * a backslash anywhere ("/\evil" is "//evil" to a browser), a scheme, control
 * characters and whitespace, and percent-encoding, query and fragment. ".." is
 * refused as in safePortalPath. Client-safe: no imports.
 */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/

export function safeInternalPath(raw: string | null | undefined): string | null {
  if (!raw || raw.includes("..")) return null
  return SAFE_PATH.test(raw) ? raw : null
}
