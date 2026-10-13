/**
 * The post-login destination, from a query value anyone can craft.
 *
 * Only a same-origin relative path is accepted. A leading "//" is
 * protocol-relative and "/\\" is read the same way by browsers (they treat "\\"
 * as "/" in special URLs), so both would leave the origin. Control characters
 * are refused too: the URL parser silently drops tab and newline, so "/\t/host"
 * becomes "//host".
 */
export function safeCallbackPath(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback
  return raw
}
