/**
 * Stitch Payments — OAuth2 client_credentials + GraphQL payment initiations
 * Docs: https://stitch.money/docs
 */

const STITCH_TOKEN_URL = "https://secure.stitch.money/connect/token"
const STITCH_GRAPHQL_URL = "https://api.stitch.money/graphql"

interface StitchTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

export async function getStitchAccessToken(): Promise<string> {
  const clientId = process.env.STITCH_CLIENT_ID
  const clientSecret = process.env.STITCH_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error("Stitch credentials not configured (STITCH_CLIENT_ID / STITCH_CLIENT_SECRET)")
  }

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

export async function createStitchPayment(
  input: StitchPaymentInput
): Promise<StitchPaymentResult> {
  const token = await getStitchAccessToken()

  const beneficiaryName = process.env.STITCH_BENEFICIARY_NAME
  // No defaults: the beneficiary is the lender's own collection account, so a
  // missing value must stop the payment rather than route it to another bank.
  const bankId = process.env.STITCH_BANK_ID
  const accountNumber = process.env.STITCH_ACCOUNT_NUMBER
  const branchCode = process.env.STITCH_BRANCH_CODE

  if (!beneficiaryName) {
    throw new Error("STITCH_BENEFICIARY_NAME not configured")
  }
  if (!bankId) {
    throw new Error("STITCH_BANK_ID not configured")
  }
  if (!accountNumber) {
    throw new Error("STITCH_ACCOUNT_NUMBER not configured")
  }
  if (!branchCode) {
    throw new Error("STITCH_BRANCH_CODE not configured")
  }

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
