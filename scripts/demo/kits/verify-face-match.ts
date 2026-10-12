/**
 * Runs the app's selfie-vs-ID face match over the live-demo kit.
 *
 *   VLM_API_URL=http://127.0.0.1:8100 VLM_MODEL=<id> \
 *     npx tsx scripts/demo/kits/verify-face-match.ts [--kit <dir>] [--as-of YYYY-MM-DD]
 *
 * Run from the repo root with the face models fetched (npm run
 * face-models:fetch), or set FACE_MODEL_DIR.
 *
 * runBiometricVerification (lib/kyc/selfie-biometric.server.ts — what both
 * selfie routes call) reads the stored ID from disk and persists the outcome
 * through Prisma, so it cannot run without a database. This script runs its
 * v3 decision chain step for step on the same functions:
 * canonicalBiometricImage on each side; on those bytes, extractDocumentData
 * with docType SELFIE + the ID as referenceImage (one two-image VLM request:
 * liveness, the portrait gates and its own match verdict, which can only
 * refuse) beside compareFaces (the YuNet + SFace face model, which decides
 * same-person); assessVlmBiometricExtraction, readVlmFaceMatchVerdict and
 * readVlmFaceMatchSideRejection; the provider result built exactly as the
 * route builds it, then assessBiometricEvidence — the gate whose `ok` becomes
 * biometricPassed — and the route's choice of the recorded failure reason.
 *
 * Cases (selfie = the presenter photo throughout):
 *   (a) each live persona's kit ID card (presenter photo printed)  → must pass
 *   (b) a background persona's photo-less specimen card            → must fail
 *   (c) a live card whose photo slot holds a drawn synthetic face  → must fail
 * Exits non-zero when any case ends the wrong way. Never prints image bytes.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  assessBiometricEvidence,
  assessVlmBiometricExtraction,
  biometricSubjectFingerprint,
  VLM_FACE_MATCH_PROVIDER,
  type BiometricEvidenceAssessment,
  type BiometricSubjectClient,
} from '@/lib/kyc/biometric-evidence'
import { canonicalBiometricImage } from '@/lib/kyc/biometric-image.server'
import { compareFaces } from '@/lib/kyc/face-model/compare.server'
import { isManualKycExceptionableFailureReason } from '@/lib/kyc/manual-exception-policy'
import { readVlmFaceMatchSideRejection, readVlmFaceMatchVerdict } from '@/lib/kyc/vlm-face-match'
import { extractDocumentData } from '@/lib/vlm-extract'
import { LIVE_DEMO_PERSONAS, getPersona } from '../personas'
import type { Persona } from '../personas/types'
import { renderIdCard } from '../specimens/id-card'
import { sastToday } from '../specimens/pay-schedule'
import { PRESENTER_PHOTO } from '../specimens/presenter-photo'
import { defaultKitDir } from './layout'

const out = (line = ''): void => { process.stdout.write(`${line}\n`) }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

interface Outcome {
  passed: boolean
  reason: string
  detail: string
}

function subjectOf(p: Persona): BiometricSubjectClient {
  return { id: `kit-${p.id}`, idNumber: p.idNumber, firstName: p.firstName, lastName: p.lastName, dateOfBirth: new Date(`${p.dateOfBirth}T00:00:00.000Z`) }
}

/** Mirrors runBiometricVerification steps A1–C without the database. */
async function faceMatch(selfie: Buffer, idCard: Buffer, p: Persona): Promise<Outcome> {
  // A1: one canonical image per side; a side that cannot be prepared refuses before either judge runs.
  const canonicalId = await canonicalBiometricImage(idCard, 'image/png')
  const canonicalSelfie = await canonicalBiometricImage(selfie, 'image/jpeg')
  if (!canonicalId.ok || !canonicalSelfie.ok) {
    const error = !canonicalId.ok ? `ID: ${canonicalId.error}` : !canonicalSelfie.ok ? `selfie: ${canonicalSelfie.error}` : ''
    return { passed: false, reason: 'extraction_incomplete', detail: `image preparation failed (${error})` }
  }
  const images = { id: canonicalId.image, selfie: canonicalSelfie.image }
  // A2: the VLM and the face model judge the same two images.
  const [vlm, faceComparison] = await Promise.all([
    extractDocumentData({
      fileBuffer: images.selfie.fileBuffer,
      mimeType: images.selfie.mimeType,
      docType: 'SELFIE',
      referenceImage: images.id,
    }),
    compareFaces(images.id, images.selfie),
  ])
  // B–C: the kit card stands in for the stored ID copy the selfie is bound to.
  const subject = subjectOf(p)
  const subjectFingerprint = biometricSubjectFingerprint(subject)
  const idDocument = { id: `kit-id-${p.id}`, contentSha256: createHash('sha256').update(idCard).digest('hex') }
  const extractionResult = vlm.data ?? null
  const vlmAssessment = assessVlmBiometricExtraction(extractionResult)
  const matchVerdict = readVlmFaceMatchVerdict(extractionResult)
  const modelRejection = faceComparison.rejection
  const sideRejection = readVlmFaceMatchSideRejection(extractionResult)
  const strictRejection = (matchVerdict?.rejection && !isManualKycExceptionableFailureReason(matchVerdict.rejection.reason)
    ? matchVerdict.rejection
    : sideRejection)
    ?? (modelRejection && !isManualKycExceptionableFailureReason(modelRejection.reason) ? modelRejection : null)
  const refusal = strictRejection ?? modelRejection ?? matchVerdict?.rejection ?? null
  const provider = vlmAssessment.ok && matchVerdict && faceComparison.ok
    ? {
        ok: true,
        verified: matchVerdict.rejection === null && faceComparison.rejection === null,
        provider: VLM_FACE_MATCH_PROVIDER,
        matchScore: matchVerdict.matchScore,
        livenessScore: matchVerdict.livenessScore,
        matchConfidence: matchVerdict.matchConfidence,
        livenessConfidence: matchVerdict.livenessConfidence,
        faceMatch: matchVerdict.faceMatch,
        idPhotoFaceDetected: matchVerdict.idPhotoFaceDetected,
        idPhotoKind: matchVerdict.idPhotoKind,
        idPhotoIsRealPhotograph: matchVerdict.idPhotoIsRealPhotograph,
        selfieIsRealPhotograph: matchVerdict.selfieIsRealPhotograph,
        samePerson: matchVerdict.samePerson,
        faceModel: faceComparison.evidence,
        idDocumentId: idDocument.id,
        idDocumentSha256: idDocument.contentSha256,
        ...(refusal === null ? {} : { error: refusal.message }),
      }
    : null
  const completed = provider !== null
  const assessment: BiometricEvidenceAssessment = !vlmAssessment.ok
    ? vlmAssessment
    : !faceComparison.ok
    ? { ok: false, reason: faceComparison.rejection.reason }
    : assessBiometricEvidence({
        deletedAt: null,
        verified: false,
        extractionStatus: completed ? 'done' : 'failed',
        extractionResult,
        extractionError: provider?.error ?? strictRejection?.message ?? vlm.error ?? null,
        validationMismatch: false,
        validationScore: provider?.matchScore ?? 0,
        biometricMatchScore: provider?.matchScore ?? null,
        biometricLiveness: provider?.livenessScore ?? null,
        biometricVerifiedAt: completed ? new Date() : null,
        biometricResult: provider ? { ...provider, subjectFingerprint } : null,
      }, { subject, idDocument, idDocumentCopies: null, requireDocumentVerified: false })
  const assessedReason = assessment.ok ? null : assessment.reason
  const reason = strictRejection?.reason
    ?? (assessedReason && !isManualKycExceptionableFailureReason(assessedReason) ? assessedReason : null)
    ?? (provider ? refusal?.reason : null)
    ?? assessedReason
  const v = (field: string): string => JSON.stringify(extractionResult?.[field]?.value ?? null)
  const model = faceComparison.ok
    ? `model similarity=${faceComparison.evidence.similarity.toFixed(3)} (threshold ${faceComparison.evidence.threshold}) ` +
      `faces id=${faceComparison.evidence.idFaceCount} selfie=${faceComparison.evidence.selfieFaceCount}`
    : `model refused: ${faceComparison.rejection.message} (faces id=${faceComparison.idFaceCount} selfie=${faceComparison.selfieFaceCount})`
  return {
    passed: assessment.ok,
    reason: assessment.ok ? 'biometricPassed' : reason ?? assessment.reason,
    detail: `${model}; ` + (vlm.ok
      ? `VLM idPhotoKind=${v('idPhotoKind')} idPhotoIsRealPhotograph=${v('idPhotoIsRealPhotograph')} idPhotoFaceDetected=${v('idPhotoFaceDetected')} ` +
        `selfieIsRealPhotograph=${v('selfieIsRealPhotograph')} samePerson=${v('samePerson')} faceMatch=${v('faceMatch')} matchConfidence=${v('matchConfidence')} ` +
        `isLive=${v('isLive')} livenessConfidence=${v('livenessConfidence')} faces=${v('facesCount')} quality=${v('quality')}`
      : `VLM extraction error: ${vlm.error ?? 'none'}`),
  }
}

/** A plainly drawn, obviously non-photographic face: a different "person" without using anyone's image. */
async function syntheticFace(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#d8dde3"/>
  <path d="M120 300 C120 90 480 90 480 300 L480 330 L120 330 Z" fill="#3b2a1f"/>
  <ellipse cx="300" cy="380" rx="170" ry="220" fill="#c99a76"/>
  <ellipse cx="235" cy="340" rx="24" ry="14" fill="#fff"/><circle cx="235" cy="340" r="10" fill="#2b1d12"/>
  <ellipse cx="365" cy="340" rx="24" ry="14" fill="#fff"/><circle cx="365" cy="340" r="10" fill="#2b1d12"/>
  <path d="M205 300 Q235 285 265 300 M335 300 Q365 285 395 300" stroke="#3b2a1f" stroke-width="8" fill="none"/>
  <path d="M300 360 L285 440 L315 440" stroke="#9c7356" stroke-width="6" fill="none"/>
  <path d="M245 500 Q300 535 355 500" stroke="#7a3b2e" stroke-width="10" fill="none"/>
  <path d="M80 800 C80 640 520 640 520 800 Z" fill="#2f4f6f"/>
</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()
}

async function main(): Promise<void> {
  if (!process.env.VLM_API_URL || !process.env.VLM_MODEL) throw new Error('set VLM_API_URL and VLM_MODEL')
  const kit = arg('kit') ?? defaultKitDir(arg('as-of') ?? sastToday())
  const selfie = readFileSync(PRESENTER_PHOTO)
  const background = getPersona('bg-04')
  const cases: Array<{ label: string; expectPass: boolean; persona: Persona; card: () => Promise<Buffer> }> = [
    ...LIVE_DEMO_PERSONAS.map((p) => ({
      label: `(a) presenter selfie vs ${p.id} kit card (presenter photo)`,
      expectPass: true,
      persona: p,
      card: async () => readFileSync(join(kit, p.id, 'id-card.png')),
    })),
    {
      label: `(b) presenter selfie vs ${background.id} card (photo-less specimen)`,
      expectPass: false,
      persona: background,
      card: () => renderIdCard(background),
    },
    {
      label: `(c) presenter selfie vs ${LIVE_DEMO_PERSONAS[0]!.id} card with a drawn synthetic face`,
      expectPass: false,
      persona: LIVE_DEMO_PERSONAS[0]!,
      card: async () => renderIdCard(LIVE_DEMO_PERSONAS[0]!, await syntheticFace()),
    },
  ]
  let wrong = 0
  for (const c of cases) {
    const started = Date.now()
    const r = await faceMatch(selfie, await c.card(), c.persona)
    const ok = r.passed === c.expectPass
    if (!ok) wrong++
    out(`${ok ? 'OK  ' : 'BAD '} ${c.label}: ${r.passed ? 'PASS' : 'FAIL'} (${r.reason}) ${r.detail} [${((Date.now() - started) / 1000).toFixed(1)}s]`)
  }
  out(wrong === 0 ? 'ALL FACE-MATCH CASES AS EXPECTED' : `${wrong} CASE(S) ENDED THE WRONG WAY`)
  process.exit(wrong === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
