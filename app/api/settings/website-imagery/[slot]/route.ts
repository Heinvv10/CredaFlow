import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { logger } from "@/lib/observability/logger"
import { StoredImageryUnreadable, removeWebsiteImage, setWebsiteImage, updateWebsiteImageText } from "@/lib/config/website-imagery"
import { IMAGERY_MAX_BYTES, parseSlot, type ImagerySlot } from "@/lib/config/website-imagery-schema"

// Public-website photos carry the same guard as the letterhead logo (see
// app/api/settings/identity/logo/route.ts): ADMIN, and a sign-in that verified a TOTP code.
const WRITE_ROLE = "ADMIN"
// The multipart envelope (field names, alt text, community sentence) on top of the file.
const ENVELOPE_BYTES = 64 * 1024
// A text edit is a few hundred bytes of JSON.
const TEXT_BODY_BYTES = 16 * 1024
const UNREADABLE = "The stored website images could not be read, so nothing was changed. Ask the platform operator to look at them."
const TOO_BIG = `The image must be at most ${IMAGERY_MAX_BYTES / (1024 * 1024)} MB.`

type Ctx = { params: Promise<{ slot: string }> }

/** The request body, or null once it passes `cap` bytes; a body that declares no length is cut off at the cap rather than buffered whole. */
async function readBodyCapped(req: NextRequest, cap: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

function refusal(error: string, status: number) {
  return NextResponse.json({ error }, { status })
}

/** The one failure with its own answer: a stored document that is not in the expected shape is never written over. */
function failed(e: unknown, what: string) {
  if (e instanceof StoredImageryUnreadable) return refusal(UNREADABLE, 409)
  logger.error(`[website-imagery] ${what}`, { reason: e instanceof Error ? e.message : String(e) })
  return refusal(`Failed to ${what}`, 500)
}

function totpRequired() {
  return refusal("Sign in with two-factor authentication to change the website images. Enable it under Settings → Security, then sign out and back in.", 403)
}

async function authorise(): Promise<{ error: NextResponse } | { user: { id: string; email: string } }> {
  const guard = await requireApiRole(WRITE_ROLE)
  if (guard.error) return { error: guard.error as NextResponse }
  if (guard.user.totpVerified !== true) return { error: totpRequired() }
  return { user: guard.user }
}

async function slotOf(ctx: Ctx): Promise<ImagerySlot | null> {
  return parseSlot((await ctx.params).slot)
}

const field = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Multipart: `file` (JPEG, PNG or WebP, validated by content), `alt`, and for the community band `heading` and `body`. Replaces what the slot held. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await authorise()
  if ("error" in auth) return auth.error
  const slot = await slotOf(ctx)
  if (!slot) return refusal("Unknown image slot.", 404)

  return withTenantContext(req, async (tenant) => {
    const cap = IMAGERY_MAX_BYTES + ENVELOPE_BYTES
    if (Number(req.headers.get("content-length") ?? 0) > cap) return refusal(TOO_BIG, 413)
    const body = await readBodyCapped(req, cap)
    if (!body) return refusal(TOO_BIG, 413)

    let form: FormData
    try {
      form = await new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type") ?? "" }, body: Buffer.from(body) }).formData()
    } catch {
      return refusal("Send the image as multipart form data.", 400)
    }
    const file = form.get("file")
    if (!(file instanceof Blob)) return refusal("Choose an image to upload.", 400)

    try {
      const result = await setWebsiteImage(prisma, {
        tenantId: tenant.id,
        actor: { id: auth.user.id, email: auth.user.email },
        slot,
        bytes: new Uint8Array(await file.arrayBuffer()),
        text: { alt: field(form, "alt"), heading: field(form, "heading"), body: field(form, "body") },
        ipAddress: callerIp(req),
      })
      return result.ok ? NextResponse.json(result) : refusal(result.error, 400)
    } catch (e) {
      return failed(e, "store the image")
    }
  })
}

/** JSON `{ alt, heading?, body? }`: edits the text of a slot that already has an image. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await authorise()
  if ("error" in auth) return auth.error
  const slot = await slotOf(ctx)
  if (!slot) return refusal("Unknown image slot.", 404)

  return withTenantContext(req, async (tenant) => {
    const body = await readBodyCapped(req, TEXT_BODY_BYTES)
    if (!body) return refusal("That text is too long.", 413)
    let text: unknown = null
    try {
      text = JSON.parse(Buffer.from(body).toString("utf8"))
    } catch {
      return refusal("Send the text as JSON.", 400)
    }
    if (text === null || typeof text !== "object") return refusal("Send the text as JSON.", 400)
    try {
      const result = await updateWebsiteImageText(prisma, {
        tenantId: tenant.id,
        actor: { id: auth.user.id, email: auth.user.email },
        slot,
        text,
        ipAddress: callerIp(req),
      })
      return result.ok ? NextResponse.json(result) : refusal(result.error, 400)
    } catch (e) {
      return failed(e, "save the text")
    }
  })
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await authorise()
  if ("error" in auth) return auth.error
  const slot = await slotOf(ctx)
  if (!slot) return refusal("Unknown image slot.", 404)

  return withTenantContext(req, async (tenant) => {
    try {
      return NextResponse.json(await removeWebsiteImage(prisma, {
        tenantId: tenant.id,
        actor: { id: auth.user.id, email: auth.user.email },
        slot,
        ipAddress: callerIp(req),
      }))
    } catch (e) {
      return failed(e, "remove the image")
    }
  })
}
