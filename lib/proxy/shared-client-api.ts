/**
 * APIs intentionally reachable from both the staff and client deployments.
 *
 * This is only the audience split. Each route still performs its own
 * ownership/role checks. Keeping the matcher in a testable module prevents a
 * new portal step from working in APP_MODE=all while being silently 404'd by
 * the real APP_MODE=client container.
 */
export function isSharedClientApiPath(pathname: string, method: string): boolean {
  if (
    pathname === "/api/documents" ||
    (pathname.startsWith("/api/documents/") && !pathname.endsWith("/extract"))
  ) {
    return true
  }
  if (/^\/api\/clients\/[^/]+\/documents$/.test(pathname)) {
    return true
  }
  if (/^\/api\/loans\/[^/]+\/statement$/.test(pathname)) {
    return true
  }
  if (/^\/api\/applications\/[^/]+\/agreement(\/sign)?$/.test(pathname)) {
    return true
  }
  if (/^\/api\/applications\/[^/]+\/pasq(\/acknowledge)?$/.test(pathname)) {
    return true
  }
  if (/^\/api\/applications\/[^/]+\/debit-mandate(\/sign)?$/.test(pathname)) {
    return true
  }
  // The packet the borrower signs, framed on the portal signing page. GET only:
  // its POST records a returned signed packet and is staff-only, as is the
  // /email sibling, and HEAD would run the GET handler and log a read that
  // served nothing.
  if (method === "GET" && /^\/api\/applications\/[^/]+\/signing-packet$/.test(pathname)) {
    return true
  }
  return false
}
