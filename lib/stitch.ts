/**
 * Stitch Payments — OAuth2 client_credentials + GraphQL payment initiations
 * Docs: https://stitch.money/docs
 */

import { prisma } from "@/lib/prisma"
import {
  isEnvCredentialsTenant,
  loadTenantCredential,
  openCredential,
  splitCredentialPair,
} from "@/lib/integrations/tenant-credentials"

const STITCH_TOKEN_URL = "https://secure.stitch.money/connect/token"
const STITCH_GRAPHQL_URL = "https://api.stitch.money/graphql"

interface StitchTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

/** A lender's Stitch account and the collection account it pays into. */
export interface StitchAccount {
  clientId: string
  clientSecret: string
  beneficiary: { name: string; bankId: string; accountNumber: string; branchCode: string }
}

/**
 * The lender's own Stitch account (TenantConfig.stitchKey, sealed
 * "clientId:clientSecret", and the stitchBeneficiary* columns), taken whole.
 * The STITCH_* environment variables are used, also whole, only when the
 * lender has no stitchKey and owns the environment credentials
 * (ENV_CREDENTIALS_TENANT_SLUG, lib/integrations/tenant-credentials.ts): a payment must never be routed to
 * another lender's account. Throws when neither is complete.
 */
export async function loadStitchAccount(tenantId: string): Promise<StitchAccount> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { stitchKey: true, stitchBeneficiaryName: true, stitchBankId: true, stitchAccountNumber: true, stitchBranchCode: true },
  })
  const own = splitCredentialPair(openCredential(config?.stitchKey))
  const source = own
    ? {
        clientId: own.id, clientSecret: own.secret, name: config?.stitchBeneficiaryName, bankId: config?.stitchBankId,
        accountNumber: config?.stitchAccountNumber, branchCode: config?.stitchBranchCode,
      }
    : (await isEnvCredentialsTenant(tenantId))
      ? {
          clientId: process.env.STITCH_CLIENT_ID, clientSecret: process.env.STITCH_CLIENT_SECRET,
          name: process.env.STITCH_BENEFICIARY_NAME, bankId: process.env.STITCH_BANK_ID,
          accountNumber: process.env.STITCH_ACCOUNT_NUMBER, branchCode: process.env.STITCH_BRANCH_CODE,
        }
      : null
  if (!source?.clientId || !source.clientSecret) {
    throw new Error("Stitch is not configured for this lender (Settings → Integrations)")
  }
  // No defaults: the beneficiary is the lender's own collection account, so a
  // missing value must stop the payment rather than route it to another bank.
  const { name, bankId, accountNumber, branchCode } = source
  if (!name || !bankId || !accountNumber || !branchCode) {
    throw new Error("Stitch beneficiary account is not configured for this lender (name, bank, account number, branch code)")
  }
  return { clientId: source.clientId, clientSecret: source.clientSecret, beneficiary: { name, bankId, accountNumber, branchCode } }
}

/**
 * The secret that signs this lender's Stitch webhooks; the deployment's
 * STITCH_WEBHOOK_SECRET only when the lender owns the environment
 * credentials (ENV_CREDENTIALS_TENANT_SLUG).
 */
export async function loadStitchWebhookSecret(tenantId: string): Promise<string | null> {
  const own = await loadTenantCredential(tenantId, "stitchWebhookSecret")
  if (own) return own
  const env = process.env.STITCH_WEBHOOK_SECRET
  return env && (await isEnvCredentialsTenant(tenantId)) ? env : null
}

export async function getStitchAccessToken(account: Pick<StitchAccount, "clientId" | "clientSecret">): Promise<string> {
  const { clientId, clientSecret } = account

  const res = await fetch(STITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "client_paymentrequest",
      audience: "https://secure.stitch.money/connect/token",
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Stitch token error ${res.status}: ${body}`)
  }

  const data = (await res.json()) as StitchTokenResponse
  return data.access_token
}

export interface StitchPaymentInput {
  /** Amount in rands (e.g. 500.00) */
  amountRands: number
  /** Max 12 chars — shown on payer's bank statement */
  payerReference: string
  beneficiaryReference: string
  externalReference: string
  redirectUrl: string
}

export interface StitchPaymentResult {
  id: string
  url: string
}

const CREATE_PAYMENT_MUTATION = `
  mutation CreatePaymentInitiationRequest($input: ClientPaymentInitiationRequestInput!) {
    clientPaymentInitiationRequestCreate(input: $input) {
      paymentInitiationRequest {
        id
        url
      }
    }
  }
`

interface GraphQLResponse {
  data?: {
    clientPaymentInitiationRequestCreate?: {
      paymentInitiationRequest?: { id: string; url: string }
    }
  }
  errors?: Array<{ message: string }>
}

/** Creates a payment request on `tenantId`'s Stitch account, into its collection account. */
export async function createStitchPayment(
  tenantId: string,
  input: StitchPaymentInput
): Promise<StitchPaymentResult> {
  const account = await loadStitchAccount(tenantId)
  const token = await getStitchAccessToken(account)
  const { name: beneficiaryName, bankId, accountNumber, branchCode } = account.beneficiary

  const res = await fetch(STITCH_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: CREATE_PAYMENT_MUTATION,
      variables: {
        input: {
          amount: {
            quantity: input.amountRands.toFixed(2),
            currency: "ZAR",
          },
          payerReference: input.payerReference.slice(0, 12),
          beneficiaryReference: input.beneficiaryReference,
          externalReference: input.externalReference,
          redirectUrl: input.redirectUrl,
          beneficiary: {
            bankAccount: {
              name: beneficiaryName,
              bankId,
              accountNumber,
              accountType: "current",
              branchCode,
            },
          },
        },
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Stitch GraphQL error ${res.status}: ${body}`)
  }

  const json = (await res.json()) as GraphQLResponse

  if (json.errors?.length) {
    throw new Error(`Stitch GraphQL: ${json.errors.map((e) => e.message).join(", ")}`)
  }

  const pr = json.data?.clientPaymentInitiationRequestCreate?.paymentInitiationRequest
  if (!pr?.id || !pr?.url) {
    throw new Error("Stitch returned no payment initiation request")
  }

  return { id: pr.id, url: pr.url }
}
