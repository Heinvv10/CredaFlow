import { defineCronJobs } from "../define"

export default defineCronJobs([
  // Fails selfie attempts stuck in `processing` past 15 minutes (a worker that
  // died mid-VLM-call) so the client can retake (lib/kyc/selfie-sweeper.server.ts).
  // Every 5 minutes: a stuck client waits at most 20.
  { route: "sweep-stuck-selfies", owner: "in-process", schedule: "*/5 * * * *", freshnessMinutes: 15 },
] as const)
