/**
 * Not every stored `InsurancePolicy.faisDisclosurePdfUrl` is something the
 * policyholder can actually open, and the difference matters: we must never
 * offer a client a "view" link that 403s, nor invite them to attest they
 * reviewed a document they were structurally unable to read.
 *
 * Two shapes exist in the wild:
 *
 *  - `/api/documents/<id>/view` — a stored ClientDocument. The route permits
 *    `caller.type === "client"` when the document is theirs, and writes a
 *    DocumentAccessLog row on every read. Client-viewable, and provable.
 *
 *  - `/api/insurance/disclosures/<draftToken>` — written for STANDALONE
 *    policies, where app/api/insurance/policies/route.ts REQUIRES the url to
 *    equal this form. That route is requireApiRole("INSURANCE_OFFICER") and
 *    the token expires after one hour, so a client can never open it (403)
 *    and staff cannot either once it has aged out.
 *
 * Returns the ClientDocument id only for the first shape.
 */
export function clientViewableDisclosureDocumentId(url: string | null): string | null {
  if (!url) return null
  const match = /^\/api\/documents\/([^/?#]+)\/view$/.exec(url)
  return match ? match[1] : null
}
