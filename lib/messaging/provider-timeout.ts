import type { Channel, Provider } from "@prisma/client"
import { dispatch, type DispatchOpts, type DispatchResult } from "./providers"
import type { RenderedTemplate } from "./render"

// Every provider adapter is aborted before the durable attempt lease expires.
// The remaining margin lets the sender persist its accepted/ambiguous outcome
// while its CAS lease is still current.
export const MESSAGE_PROVIDER_TIMEOUT_MS = 20_000
export const MESSAGE_DISPATCH_LEASE_MS = 60_000

export async function dispatchWithinTimeout(
  channel: Channel,
  provider: Provider,
  rendered: RenderedTemplate,
  opts: DispatchOpts,
  timeoutMs = MESSAGE_PROVIDER_TIMEOUT_MS,
): Promise<DispatchResult> {
  if (timeoutMs <= 0 || timeoutMs >= MESSAGE_DISPATCH_LEASE_MS) {
    throw new Error("Provider timeout must be positive and shorter than the dispatch lease")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forwardAbort = () => controller.abort()
  opts.signal?.addEventListener("abort", forwardAbort, { once: true })

  try {
    return await Promise.race([
      dispatch(channel, provider, rendered, { ...opts, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(`Provider dispatch exceeded ${timeoutMs}ms deadline`))
        }, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", forwardAbort)
  }
}
