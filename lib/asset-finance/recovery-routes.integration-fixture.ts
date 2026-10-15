/**
 * The slice 4a recovery core routes as callable functions for the integration
 * suites (RUN_ASSET_FINANCE_RECOVERY_IT), plus a PDF text reader. Each call
 * builds a request for the tenant's host and answers { status, body }. Not a
 * test file.
 */
import { NextRequest } from "next/server"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { POST as createRoute, GET as listRoute } from "@/app/api/asset-finance/loans/[loanId]/recoveries/route"
import { GET as viewRoute } from "@/app/api/asset-finance/recoveries/[id]/route"
import { POST as valuationRoute } from "@/app/api/asset-finance/recoveries/[id]/valuation/route"
import { POST as valuationNoticeRoute } from "@/app/api/asset-finance/recoveries/[id]/valuation-notice/route"
import { POST as listForSaleRoute } from "@/app/api/asset-finance/recoveries/[id]/list/route"
import { POST as costsRoute } from "@/app/api/asset-finance/recoveries/[id]/costs/route"
import { POST as decideRoute } from "@/app/api/asset-finance/recoveries/[id]/costs/[costId]/decide/route"
import { POST as finalNoticeRoute } from "@/app/api/asset-finance/recoveries/[id]/final-notice/route"
import { POST as withdrawRoute } from "@/app/api/asset-finance/recoveries/[id]/withdraw/route"
import { POST as closeRoute } from "@/app/api/asset-finance/recoveries/[id]/close/route"
import { GET as refundDocumentRoute } from "@/app/api/asset-finance/recoveries/[id]/refund/document/route"
import { GET as documentRoute } from "@/app/api/asset-finance/recoveries/[id]/documents/[kind]/route"
import { POST as surrenderValuationRoute } from "@/app/api/asset-finance/surrenders/[id]/valuation/route"
import { POST as surrenderValuationNoticeRoute } from "@/app/api/asset-finance/surrenders/[id]/valuation-notice/route"
import { POST as surrenderProceedsRoute } from "@/app/api/asset-finance/surrenders/[id]/proceeds/route"
import { GET as portalRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/recovery/route"

export interface Answer { status: number; body: Record<string, unknown> }
const answer = async (response: Response): Promise<Answer> => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })

export function recoveryRoutes(host: string) {
  const req = (path: string, method: "GET" | "POST", body?: unknown) => new NextRequest(`http://${host}${path}`, {
    method, headers: { host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const rec = (id: string, tail: string) => `/api/asset-finance/recoveries/${id}${tail}`
  const withId = (id: string) => ({ params: Promise.resolve({ id }) })
  const post = (route: typeof valuationNoticeRoute, tail: string) => async (id: string, body: unknown = {}) => answer(await route(req(rec(id, tail), "POST", body), withId(id)))
  return {
    create: async (loanId: string, body: unknown) => answer(await createRoute(req(`/api/asset-finance/loans/${loanId}/recoveries`, "POST", body), { params: Promise.resolve({ loanId }) })),
    list: async (loanId: string) => answer(await listRoute(req(`/api/asset-finance/loans/${loanId}/recoveries`, "GET"), { params: Promise.resolve({ loanId }) })),
    view: async (id: string) => answer(await viewRoute(req(rec(id, ""), "GET"), withId(id))),
    valuation: post(valuationRoute, "/valuation"),
    valuationNotice: post(valuationNoticeRoute, "/valuation-notice"),
    listForSale: post(listForSaleRoute, "/list"),
    cost: post(costsRoute, "/costs"),
    decideCost: async (id: string, costId: string, body: unknown) => answer(await decideRoute(req(rec(id, `/costs/${costId}/decide`), "POST", body), { params: Promise.resolve({ id, costId }) })),
    finalNotice: post(finalNoticeRoute, "/final-notice"),
    withdraw: post(withdrawRoute, "/withdraw"),
    close: post(closeRoute, "/close"),
    document: (id: string, kind: string) => documentRoute(req(rec(id, `/documents/${kind}`), "GET"), { params: Promise.resolve({ id, kind }) }),
    refundDocument: (id: string) => refundDocumentRoute(req(rec(id, "/refund/document"), "GET"), withId(id)),
    surrenderValuation: async (id: string, body: unknown) => answer(await surrenderValuationRoute(req(`/api/asset-finance/surrenders/${id}/valuation`, "POST", body), withId(id))),
    surrenderValuationNotice: async (id: string) => answer(await surrenderValuationNoticeRoute(req(`/api/asset-finance/surrenders/${id}/valuation-notice`, "POST", {}), withId(id))),
    surrenderProceeds: async (id: string, body: unknown) => answer(await surrenderProceedsRoute(req(`/api/asset-finance/surrenders/${id}/proceeds`, "POST", body), withId(id))),
    portal: async (loanId: string) => answer(await portalRoute(req(`/api/portal/asset-finance/loans/${loanId}/recovery`, "GET"), { params: Promise.resolve({ loanId }) })),
  }
}

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")

/** The text runs a rendered PDF prints. */
export async function pdfTexts(bytes: Uint8Array): Promise<string[]> {
  return (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
}
