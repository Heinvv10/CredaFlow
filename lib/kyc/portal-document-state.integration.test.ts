/**
 * Real-Postgres proof that portal documents and the derived KYC checklist use
 * one repeatable-read snapshot.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_PORTAL_KYC_SNAPSHOT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/portal-document-state.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import {
  PORTAL_KYC_SNAPSHOT_OPTIONS,
  readPortalKycDocumentState,
} from "./portal-document-state"

const RUN = process.env.RUN_PORTAL_KYC_SNAPSHOT_IT === "1"
const suite = RUN ? describe : describe.skip

suite("portal KYC repeatable-read projection", () => {
  const db = new PrismaClient()
  const writer = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_portal_snapshot_${token}`
  const createdClientIds: string[] = []
  const createdDocumentIds: string[] = []

  beforeAll(async () => {
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `portal-snapshot-${token}`,
        name: "Portal snapshot integration test",
      },
    })
  })

  afterAll(async () => {
    await db.clientDocument.deleteMany({
      where: { id: { in: createdDocumentIds } },
    })
    await db.client.deleteMany({
      where: { id: { in: createdClientIds } },
    })
    await db.tenant.delete({ where: { id: tenantId } })
    await Promise.all([db.$disconnect(), writer.$disconnect()])
  })

  async function createPendingSelfie(caseName: string) {
    const clientId = `client_portal_snapshot_${caseName}_${token}`
    const documentId = `document_portal_snapshot_${caseName}_${token}`
    createdClientIds.push(clientId)
    createdDocumentIds.push(documentId)

    await db.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLI-PORTAL-${caseName}-${token}`,
        idNumber: `PORTAL-${caseName}-${token}`,
        firstName: "Synthetic",
        lastName: "Snapshot",
        email: `portal-${caseName}-${token}@test.invalid`,
        phone: "+27820000021",
      },
    })
    await db.clientDocument.create({
      data: {
        id: documentId,
        tenantId,
        clientId,
        docType: "SELFIE",
        fileUrl: "",
        fileName: `${caseName}.jpg`,
        extractionStatus: "processing",
      },
    })
    return { clientId, documentId }
  }

  it.each([
    { caseName: "rejected", mutation: "reject" as const },
    { caseName: "deleted", mutation: "delete" as const },
  ])(
    "does not mix pre- and post-$mutation rows during a concurrent staff mutation",
    async ({ caseName, mutation }) => {
      const { clientId, documentId } =
        await createPendingSelfie(caseName)
      let interleaved = false
      const snapshotClient = db.$extends({
        query: {
          client: {
            async findFirst({ args, query }) {
              const result = await query(args)
              if (!interleaved) {
                interleaved = true
                await writer.clientDocument.update({
                  where: { id: documentId },
                  data: mutation === "reject"
                    ? {
                        extractionStatus: "done",
                        extractionResult: {
                          faceDetected: { value: false },
                          facesCount: { value: 0 },
                          isLive: { value: false },
                          quality: { value: "unusable" },
                        },
                        verificationNote: "Staff rejected this selfie",
                      }
                    : {
                        deletedAt: new Date("2026-07-23T07:00:00.000Z"),
                        deletedByType: "staff",
                        deletedById: "snapshot-reviewer",
                      },
                })
              }
              return result
            },
          },
        },
      })

      const duringMutation = await snapshotClient.$transaction(
        (tx) => readPortalKycDocumentState(tx, {
          tenantId,
          clientWhere: { id: clientId },
        }),
        PORTAL_KYC_SNAPSHOT_OPTIONS,
      )

      expect(interleaved).toBe(true)
      expect(duringMutation).not.toBeNull()
      expect(duringMutation?.documents).toHaveLength(1)
      expect(duringMutation?.documents[0]).toMatchObject({
        id: documentId,
        deletedAt: null,
        verificationNote: null,
      })
      expect(duringMutation?.kycChecklist.selfie).toMatchObject({
        documentId,
        status: "pending_review",
        reason: "extraction_incomplete",
      })

      const afterMutation = await db.$transaction(
        (tx) => readPortalKycDocumentState(tx, {
          tenantId,
          clientWhere: { id: clientId },
        }),
        PORTAL_KYC_SNAPSHOT_OPTIONS,
      )

      if (mutation === "reject") {
        expect(afterMutation?.documents[0]?.verificationNote).toBe(
          "Staff rejected this selfie",
        )
        expect(afterMutation?.kycChecklist.selfie).toMatchObject({
          documentId,
          status: "action_required",
          reason: "face_not_detected",
        })
      } else {
        expect(afterMutation?.documents).toEqual([])
        expect(afterMutation?.kycChecklist.selfie).toMatchObject({
          documentId: null,
          status: "missing",
          reason: "document_deleted",
        })
      }
    },
  )
})
