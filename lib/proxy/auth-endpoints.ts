/** Only this Auth.js action clears the session; it must not also renew it. */
export function isCanonicalSignOutPost(req: { method: string; nextUrl: { pathname: string } }): boolean {
  return req.method === "POST" && req.nextUrl.pathname === "/api/auth/signout"
}
