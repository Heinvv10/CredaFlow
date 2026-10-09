/**
 * Neon Keep-Alive — pings DB every 4 minutes to prevent free-tier suspension
 */

import { prisma } from "@/lib/prisma"

let keepAliveInterval: ReturnType<typeof setInterval> | null = null

export function startKeepAlive(): void {
  if (process.env.NODE_ENV !== "production") return
  if (keepAliveInterval) return

  keepAliveInterval = setInterval(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
    } catch {
      /* silent — connection will recover on next attempt */
    }
  }, 4 * 60 * 1000)
}
