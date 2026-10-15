/**
 * Adapter SKELETONS for bureaus whose integration specifications we do not
 * hold yet: XDS, VeriCred (VCCB), Consumer Profile Bureau (CPB) and MyData.
 *
 * No wire format is implemented or guessed. Each adapter declares its
 * credential bag (PROVISIONAL: the generic username / password / endpoint
 * every South African bureau API we know of asks for — confirm against the
 * bureau's integration pack) and refuses every enquiry with a typed error:
 *   NOT_CONFIGURED  — the tenant has not stored the bureau's credentials
 *   NOT_IMPLEMENTED — credentials exist, the request/response mapping does not
 * Both are recorded as failed attempts and the run falls back to the next
 * bureau in the tenant's order (lib/bureau/enquiry.ts).
 *
 * To go live: replace `enquiry` with a real client in its own file, map the
 * response into BureauReport, set `implemented: true` and the real
 * capabilities, and add fixture-driven parse tests from the bureau's samples.
 */
import { BureauProviderError, type BureauProvider } from "../types"

const PROVISIONAL_CREDENTIAL_FIELDS = ["username", "password", "endpointUrl"] as const

function skeleton(id: string, displayName: string): BureauProvider {
  return {
    id,
    displayName,
    capabilities: {
      score: null,
      tradelines: false,
      judgements: false,
      defaults: false,
      enquiryCount: false,
      pep: false,
      fraud: false,
      implemented: false,
    },
    credentialFields: PROVISIONAL_CREDENTIAL_FIELDS,
    async enquiry(_request, context) {
      const creds = context.credentials
      const missing = PROVISIONAL_CREDENTIAL_FIELDS.filter((field) => !creds?.[field]?.trim())
      if (missing.length > 0) {
        throw new BureauProviderError(
          "NOT_CONFIGURED",
          `${displayName} is not configured for this tenant (missing: ${missing.join(", ")})`,
        )
      }
      throw new BureauProviderError(
        "NOT_IMPLEMENTED",
        `${displayName} enquiry is not implemented: awaiting the bureau's integration specification`,
      )
    },
  }
}

export const xdsBureau = skeleton("xds", "XDS (Xpert Decision Systems)")
export const vccbBureau = skeleton("vccb", "VeriCred Credit Bureau (VCCB)")
export const cpbBureau = skeleton("cpb", "Consumer Profile Bureau (CPB)")
export const mydataBureau = skeleton("mydata", "MyData")

export const SKELETON_BUREAUS: readonly BureauProvider[] = [xdsBureau, vccbBureau, cpbBureau, mydataBureau]
