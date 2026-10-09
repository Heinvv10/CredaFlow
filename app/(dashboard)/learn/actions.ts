"use server"

import { revalidatePath } from "next/cache"
import { requireMinRole } from "@/lib/auth-guards"
import { getDefaultTenantId } from "@/lib/tenant"
import { setLessonComplete } from "@/lib/manual/progress"

export async function toggleLesson(lessonSlug: string, complete: boolean): Promise<{ completed: boolean }> {
  const user = await requireMinRole("READONLY")

  const tenantId = await getDefaultTenantId()
  const result = await setLessonComplete({
    tenantId,
    userId: user.id,
    userEmail: user.email ?? "",
    lessonSlug,
    complete,
  })

  revalidatePath("/learn")
  revalidatePath(`/learn/${lessonSlug}`)
  return result
}
