/**
 * proxy.ts's matcher used to skip every path ending in an image extension, so
 * a request of ANY method to /anything/x.png never reached the proxy (a form
 * post to a dynamic route with such a segment skipped the TOTP enrolment hold).
 * The matcher now lets them all in; a plain read of an image is then answered
 * at once, and only a read (GET/HEAD) is: the extension decides nothing for a
 * write. Same suffix list and case rule as the old matcher.
 */
const IMAGE_SUFFIX = /\.(?:png|jpg|jpeg|webp|svg|ico)$/

export function isImageRead(req: { method: string; nextUrl: { pathname: string } }): boolean {
  return (req.method === "GET" || req.method === "HEAD") && IMAGE_SUFFIX.test(req.nextUrl.pathname)
}
