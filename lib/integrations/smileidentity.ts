/**
 * Smile Identity integration — SA ID verification
 */

import { createHmac } from "crypto"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"

interface VerifyIdOptions {
  idNumber: string
  firstName: string
  lastName: string
  dateOfBirth: string
  phone?: string
}

interface VerifyIdResult {
  ok: boolean
  verified: boolean
  confidence?: number
  actions?: Record<string, string>
  error?: string
}

export interface BiometricVerifyResult {
  ok: boolean
  verified: boolean
  /** Synthetic provider response. Never valid KYC evidence. */
  simulated?: true
  matchScore?: number
  livenessScore?: number
  actions?: Record<string, string>
  error?: string
}

/**
 * Retained as the named entry point (it is called directly by callers and
 * tests), but the policy now lives in `simulation-guard.ts` so all five
 * outcome-fabricating integrations share ONE implementation. This function was
 * the only such guard in the codebase; four other providers had none.
 *
 * Semantics are unchanged: on a deployed build, SMILE_DRY_RUN is permitted only
 * when SMILE_IDENTITY_ENV is the explicit, known-safe "test" value — the same
 * signal getConfig() uses to pick the sandbox API. Unset or misspelled fails
 * closed, so a go-live deploy that forgets to clear the flag is caught rather
 * than silently letting fabricated biometric results reach production.
 */
export function assertSmileIdentityRuntimeSafety(): void {
  assertSimulationAllowed("smileidentity", process.env.SMILE_DRY_RUN === "true")
}

function smileSimulationEnabled(): boolean {
  assertSmileIdentityRuntimeSafety()
  return process.env.NODE_ENV === "test" || process.env.SMILE_DRY_RUN === "true"
}

function getConfig(): { apiKey: string; partnerId: string; baseUrl: string } | null {
  const apiKey = process.env.SMILE_IDENTITY_API_KEY
  const partnerId = process.env.SMILE_IDENTITY_PARTNER_ID
  if (!apiKey || !partnerId) return null

  const isProd = process.env.SMILE_IDENTITY_ENV === "production"
  const baseUrl = isProd
    ? "https://api.smileidentity.com/v1"
    : "https://testapi.smileidentity.com/v1"

  return { apiKey, partnerId, baseUrl }
}

function generateSignature(apiKey: string, timestamp: string): string {
  return createHmac("sha256", apiKey).update(timestamp).digest("base64")
}

export async function verifyId(opts: VerifyIdOptions): Promise<VerifyIdResult> {
  if (smileSimulationEnabled()) {
    return { ok: true, verified: true, confidence: 99 }
  }

  const config = getConfig()
  if (!config) {
    return { ok: false, verified: false, error: "Smile Identity not configured" }
  }

  const timestamp = new Date().toISOString()
  const signature = generateSignature(config.apiKey, timestamp)

  const payload = {
    partner_id: config.partnerId,
    timestamp,
    signature,
    source_sdk: "lms",
    source_sdk_version: "1.0.0",
    partner_params: {
      job_id: `lms-${Date.now()}`,
      user_id: opts.idNumber,
      job_type: 5, // Enhanced KYC
    },
    id_info: {
      country: "ZA",
      id_type: "NATIONAL_ID",
      id_number: opts.idNumber,
      first_name: opts.firstName,
      last_name: opts.lastName,
      dob: opts.dateOfBirth,
      phone_number: opts.phone ?? "",
    },
  }

  try {
    const res = await fetch(`${config.baseUrl}/id_verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const errText = await res.text()
      return { ok: false, verified: false, error: `Smile ID error ${res.status}: ${errText}` }
    }

    const data = await res.json()
    const resultCode = String(data.ResultCode ?? data.result_code ?? "")
    const verified = resultCode === "1012" || resultCode === "1020"
    const confidence = data.ConfidenceValue ?? data.confidence_value

    return {
      ok: true,
      verified,
      confidence: typeof confidence === "number" ? confidence : undefined,
      actions: data.Actions ?? data.actions,
    }
  } catch (e) {
    return { ok: false, verified: false, error: e instanceof Error ? e.message : "Smile ID request failed" }
  }
}

export async function verifyBiometric(opts: {
  selfieBase64: string
  idNumber: string
  firstName: string
  lastName: string
  dateOfBirth: string
  partnerUserId: string
}): Promise<BiometricVerifyResult> {
  if (smileSimulationEnabled()) {
    return { ok: true, verified: true, simulated: true, matchScore: 98, livenessScore: 97 }
  }

  const config = getConfig()
  if (!config) {
    return { ok: false, verified: false, error: "Smile Identity not configured" }
  }

  const timestamp = new Date().toISOString()
  const signature = generateSignature(config.apiKey, timestamp)

  const payload = {
    partner_id: config.partnerId,
    timestamp,
    signature,
    source_sdk: "lms",
    source_sdk_version: "1.0.0",
    partner_params: {
      job_id: `lms-bio-${Date.now()}`,
      user_id: opts.partnerUserId,
      job_type: 1,
    },
    id_info: {
      country: "ZA",
      id_type: "NATIONAL_ID",
      id_number: opts.idNumber,
      first_name: opts.firstName,
      last_name: opts.lastName,
      dob: opts.dateOfBirth,
    },
    images: [
      {
        image_type_id: 2,
        image: opts.selfieBase64,
      },
    ],
  }

  try {
    const res = await fetch(`${config.baseUrl}/biometric_kyc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const errText = await res.text()
      return { ok: false, verified: false, error: `Smile ID biometric error ${res.status}: ${errText}` }
    }

    const data = await res.json()
    const resultCode = String(data.ResultCode ?? data.result_code ?? "")
    const verified = resultCode === "1012" || resultCode === "1020"
    const confidence = data.ConfidenceValue ?? data.confidence_value
    const matchScore = typeof confidence === "number" ? confidence : undefined
    const livenessScore = data.Actions?.Liveness === "Passed" ? 99 : data.Actions?.Liveness === "Failed" ? 10 : undefined

    return {
      ok: true,
      verified,
      matchScore,
      livenessScore,
      actions: data.Actions ?? data.actions,
    }
  } catch (e) {
    return { ok: false, verified: false, error: e instanceof Error ? e.message : "Smile ID biometric request failed" }
  }
}
