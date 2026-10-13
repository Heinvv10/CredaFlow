/**
 * proxy.ts's matcher used to skip every path ending in an image extension, so
 * a request of ANY method to /anything/x.png never reached the proxy: a form
 * post to a dynamic route with such a segment skipped the TOTP enrolment hold,
 * and on the client host /clients/x.png ran the staff app with no audience gate.
 * The matcher now lets them all in. Only a read of a file that really is in
 * public/ is answered before the session is decoded; the suffix alone decides
 * nothing, because a dynamic segment (/clients/[id]) can take "x.png". Writes
 * and every other image-suffixed path go through the full proxy.
 *
 * The list is the image files under public/, checked against the directory by
 * static-image.test.ts: adding a file there fails that test until it is listed.
 */
export const PUBLIC_IMAGE_FILES: readonly string[] = [
  "/file.svg",
  "/globe.svg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
]

const PUBLIC_IMAGES = new Set(PUBLIC_IMAGE_FILES)

export function isStaticAssetRead(req: { method: string; nextUrl: { pathname: string } }): boolean {
  return (req.method === "GET" || req.method === "HEAD") && PUBLIC_IMAGES.has(req.nextUrl.pathname)
}
