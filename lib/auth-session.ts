import { cache } from "react"
import { auth } from "@/lib/auth"

/**
 * Request-scoped session read.
 *
 * Sessions live in the database, so every bare `auth()` is a round trip — and a
 * dashboard page renders inside a layout that has already resolved the same
 * session for the same request. React's `cache()` collapses those into one
 * lookup. Prefer this over `auth()` in server components; `auth()` itself is
 * still correct in route handlers and middleware, which have no shared render.
 */
export const getSession = cache(async () => auth())
