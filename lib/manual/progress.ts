import { prisma } from "@/lib/prisma"
import { logAudit, AuditAction } from "@/lib/audit"
import { findLesson } from "./curriculum"

type SetArgs = {
  tenantId: string
  userId: string
  userEmail: string
  lessonSlug: string
  complete: boolean
}

export async function setLessonComplete(args: SetArgs): Promise<{ completed: boolean }> {
  if (!findLesson(args.lessonSlug)) throw new Error("Unknown lesson")

  if (args.complete) {
    await prisma.manualProgress.upsert({
      where: { userId_lessonSlug: { userId: args.userId, lessonSlug: args.lessonSlug } },
      create: { tenantId: args.tenantId, userId: args.userId, lessonSlug: args.lessonSlug },
      update: {},
    })
  } else {
    await prisma.manualProgress.deleteMany({
      where: { userId: args.userId, lessonSlug: args.lessonSlug },
    })
  }

  await logAudit({
    tenantId: args.tenantId,
    userId: args.userId,
    userEmail: args.userEmail,
    action: args.complete ? AuditAction.MANUAL_LESSON_COMPLETED : AuditAction.MANUAL_LESSON_REOPENED,
    entity: "ManualProgress",
    entityId: args.lessonSlug,
  })

  return { completed: args.complete }
}

export async function getCompletedSlugs(userId: string): Promise<string[]> {
  const rows = await prisma.manualProgress.findMany({
    where: { userId },
    select: { lessonSlug: true },
  })
  return rows.map((r) => r.lessonSlug)
}
