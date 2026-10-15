import { DEFAULT_LOCALE, type Locale } from "./locales"
import { CATALOGS, type Messages, type Namespace } from "./catalog"

/** The `{name}` placeholders in a message, read from the English literal type. */
export type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never

export type MessageKey<N extends Namespace> = keyof Messages[N] & string

type VarsArg<S> = S extends string
  ? [Placeholders<S>] extends [never]
    ? []
    : [vars: Record<Placeholders<S>, string | number>]
  : []

/**
 * A namespace's translator. Keys are checked against the English catalogue,
 * and a message with placeholders cannot be called without every one of them.
 */
export type Translator<N extends Namespace> = <K extends MessageKey<N>>(
  key: K,
  ...vars: VarsArg<Messages[N][K]>
) => string

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * Fills `{name}` placeholders. A placeholder without a value throws: the
 * types make that unreachable from typed callers, and a message rendered with
 * a literal "{amount}" in it is worse than a failed render.
 */
export function interpolate(message: string, vars: Record<string, string | number> = {}): string {
  return message.replace(PLACEHOLDER, (_match, name: string) => {
    if (!(name in vars)) throw new Error(`i18n: missing value for placeholder "{${name}}"`)
    return String(vars[name])
  })
}

/** The raw catalogue string, before interpolation (used by rich text). */
export function lookupMessage<N extends Namespace>(locale: Locale, namespace: N, key: MessageKey<N>): string {
  const table = CATALOGS[locale][namespace] as Record<string, string>
  const message = table[key] ?? (CATALOGS[DEFAULT_LOCALE][namespace] as Record<string, string>)[key]
  if (message === undefined) throw new Error(`i18n: no message "${namespace}.${key}"`)
  return message
}

export function createTranslator<N extends Namespace>(locale: Locale, namespace: N): Translator<N> {
  return ((key: MessageKey<N>, vars?: Record<string, string | number>) =>
    interpolate(lookupMessage(locale, namespace, key), vars)) as Translator<N>
}
