// Lead scoring algorithm for the CRM
// Score 0-100 based on multiple factors

import { Lead } from "@prisma/client"

export type LeadWithFinancials = Lead & {
  _count?: { activities: number }
}

export function calculateLeadScore(lead: LeadWithFinancials): number {
  let score = 0

  // 1. Affordability ratio (30 points)
  if (lead.declaredIncome && lead.requestedAmount) {
    const ratio = lead.requestedAmount / lead.declaredIncome
    if (ratio <= 0.3) score += 30 // Excellent
    else if (ratio <= 0.5) score += 20 // Good
    else if (ratio <= 0.75) score += 10 // Fair
    // else 0: Poor affordability
  } else {
    score += 15 // Partial credit if missing data
  }

  // 2. Employment type (20 points)
  switch (lead.employmentType) {
    case "SALARIED":
      score += 20
      break
    case "SELF_EMPLOYED":
      score += 12
      break
    case "RETIRED":
      score += 8
      break
    case "UNEMPLOYED":
      break
    default:
      score += 10
  }

  // 3. Source quality (25 points)
  switch (lead.source) {
    case "REFERRAL":
      score += 25
      break
    case "WEBSITE":
      score += 15
      break
    case "WALK_IN":
      score += 10
      break
    case "SOCIAL":
      score += 8
      break
    case "MANUAL":
      score += 5
      break
    default:
      score += 5
  }

  // 4. Lead freshness (15 points)
  const ageMinutes = (Date.now() - new Date(lead.createdAt).getTime()) / 60000
  const ageDays = ageMinutes / 1440
  if (ageDays <= 1) score += 15
  else if (ageDays <= 3) score += 12
  else if (ageDays <= 7) score += 8
  else if (ageDays <= 14) score += 5
  // else 0: stale

  // 5. Activity engagement (10 points)
  const activityCount = lead._count?.activities ?? 0
  if (activityCount >= 3) score += 10
  else if (activityCount >= 1) score += 5

  return Math.min(100, Math.max(0, score))
}

export function getScoreTier(score: number): { label: string; color: string; bg: string } {
  if (score >= 80) return { label: "HOT", color: "#DC2626", bg: "#FEE2E2" }
  if (score >= 60) return { label: "WARM", color: "#EA580C", bg: "#FFEDD5" }
  if (score >= 40) return { label: "COOL", color: "#F59E0B", bg: "#FEF3C7" }
  return { label: "COLD", color: "#6B7280", bg: "#F3F4F6" }
}

/**
 * Work-queue priority = lead score weighted up by how long it has sat
 * untouched. A lead untouched for 7 days counts double, 14 days triple — so a
 * merely-good lead going stale outranks a hot one just worked. This is what
 * orders the "who to call next" queue.
 */
export function leadQueuePriority(score: number, updatedAt: Date, now: number = Date.now()): number {
  const daysSinceTouch = Math.max(0, (now - new Date(updatedAt).getTime()) / 86_400_000)
  return score * (1 + daysSinceTouch / 7)
}
