import { ALLOWED_MIME_TYPES, MAGIC_BYTE_PREFIX, MAX_FILE_SIZE, matchesMagic } from "@/lib/document-auth"
import { toDayNumber } from "./dates"
import type { ParsedEntityUpload } from "./entity-document-io"
import { LEGAL_STEP_KINDS, type LegalStepKind } from "./legal-matter-hint"

export type Fields = Record<string, string>

export interface LegalStepInput {
  kind: LegalStepKind
  stepDate: string
  note: string | null
  section129RecordId: string | null
  correctsStepId: string | null
  /** SETTLED / WITHDRAWN only: close the matter with the step. */
  closeMatter: boolean
  /** ASSET_RECOVERED only: where the asset is and what state it is in. */
  recovery: { location: string; condition: string } | null
  evidence: ParsedEntityUpload | null
}

export interface AppointAttorneyInput { supplierId: string; appointedOn: string }

export type Parsed<T> = { data: T } | { errors: Fields }

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

function validDate(value: string, today: string, label: string, errors: Fields): void {
  try {
    toDayNumber(value, label)
  } catch {
    errors[label] = "Provide the date as YYYY-MM-DD"
    return
  }
  if (value > today) errors[label] = "The date cannot be in the future"
}

/** Validates the text fields of a step; `today` is the SAST calendar date. */
export function parseLegalStepFields(raw: Record<string, unknown>, today: string, evidence: ParsedEntityUpload | null): Parsed<LegalStepInput> {
  const errors: Fields = {}
  const kind = str(raw.kind) as LegalStepKind
  if (!LEGAL_STEP_KINDS.includes(kind)) errors.kind = `kind must be one of ${LEGAL_STEP_KINDS.join(", ")}`
  const stepDate = str(raw.stepDate)
  validDate(stepDate, today, "stepDate", errors)
  const note = str(raw.note)
  if (note.length > 2_000) errors.note = "The note is at most 2000 characters"
  const section129RecordId = str(raw.section129RecordId)
  if (kind === "S129_SENT" && !section129RecordId) errors.section129RecordId = "Choose the completed section 129 notice this step records"
  if (kind !== "S129_SENT" && section129RecordId) errors.section129RecordId = "Only a section 129 step names a notice record"
  const closeMatter = raw.closeMatter === true || raw.closeMatter === "true"
  if (closeMatter && kind !== "SETTLED" && kind !== "WITHDRAWN") errors.closeMatter = "Only a settled or withdrawn step closes the matter"
  let recovery: LegalStepInput["recovery"] = null
  if (kind === "ASSET_RECOVERED") {
    const location = str(raw.location)
    const condition = str(raw.condition)
    if (location.length < 2 || location.length > 500) errors.location = "Describe the yard or location in 2 to 500 characters"
    if (condition.length < 3 || condition.length > 2_000) errors.condition = "Describe the asset condition in 3 to 2000 characters"
    recovery = { location, condition }
  }
  if (Object.keys(errors).length > 0) return { errors }
  return { data: {
    kind, stepDate, note: note || null, section129RecordId: section129RecordId || null,
    correctsStepId: str(raw.correctsStepId) || null, closeMatter, recovery, evidence,
  } }
}

export async function parseEvidenceFile(file: File): Promise<{ upload: ParsedEntityUpload } | { error: string }> {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) return { error: "File type not allowed. Accepted: JPEG, PNG, WebP, PDF" }
  if (file.size === 0) return { error: "The file is empty" }
  if (file.size > MAX_FILE_SIZE) return { error: "File too large. Maximum 10MB" }
  const head = new Uint8Array(await file.slice(0, MAGIC_BYTE_PREFIX).arrayBuffer())
  if (!matchesMagic(head, file.type)) return { error: "File content does not match its type" }
  return { upload: { file, docType: "LEGAL_DOCUMENT", dealId: null } }
}

/** A step arrives as JSON, or as multipart form data when it carries an evidence file. */
export async function parseLegalStepRequest(req: Request, today: string): Promise<Parsed<LegalStepInput>> {
  if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return { errors: { body: "Expected a JSON object" } }
    return parseLegalStepFields(body, today, null)
  }
  const form = await req.formData().catch(() => null)
  if (!form) return { errors: { body: "Expected multipart form data" } }
  const raw: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) if (typeof value === "string") raw[key] = value
  const file = form.get("file")
  let evidence: ParsedEntityUpload | null = null
  if (file !== null) {
    if (!(file instanceof File)) return { errors: { file: "file must be a file" } }
    const parsed = await parseEvidenceFile(file)
    if ("error" in parsed) return { errors: { file: parsed.error } }
    evidence = parsed.upload
  }
  return parseLegalStepFields(raw, today, evidence)
}

export function parseAppointAttorney(raw: unknown, today: string): Parsed<AppointAttorneyInput> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const errors: Fields = {}
  const supplierId = str(body.supplierId)
  if (!supplierId) errors.supplierId = "Choose the attorney's supplier record"
  const appointedOn = str(body.appointedOn)
  validDate(appointedOn, today, "appointedOn", errors)
  return Object.keys(errors).length > 0 ? { errors } : { data: { supplierId, appointedOn } }
}
