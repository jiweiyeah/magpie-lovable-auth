// Lovable's AI Gateway as a magpie provider.
//
// Three things this does that magpie's built-in custom provider cannot:
//
//   1. Strips the Anthropic beta headers Claude Code sends and the gateway
//      refuses, and the three body fields it refuses with them. magpie's
//      custom provider passes both through untouched, so every Claude Code
//      turn is a 400.
//
//   2. Keeps a key pool. Each key is a magpie account (`lovable`,
//      `lovable#abc123`), and the pool survives a key that runs out: a 402
//      is the account's and does not lift, so that key is taken out for
//      good rather than retried on every turn.
//
//   3. Says what each key has done. Lovable publishes no allowance
//      endpoint, so the only reading is the book this plugin keeps.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { filterBetas, scrubBody } from "./headers.mjs"
import { Book, describe, idOf } from "./keys.mjs"
import {
  BASE,
  configModel,
  normalizeFallback,
  parseListing,
  runtimeModel,
} from "./models.mjs"

export const ID = "lovable"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOOK_FILE = path.join(HERE, "..", ".lovable-book.json")

// CATALOG_TTL_MS is how long a listing is trusted. The gateway's catalog
// changes when it ships a model, which is not hourly; a minute of staleness
// costs nothing and a read per turn would.
const CATALOG_TTL_MS = 10 * 60 * 1000

// bookOf is one Book per process, made on first use.
let book
function getBook(options) {
  if (!book) book = new Book(options?.book ?? BOOK_FILE)
  return book
}

// catalog caches the gateway's listing. It is per process and shared by
// every account: the catalog is the same for all of them.
let catalog = { at: 0, models: [] }

async function readCatalog(signal) {
  if (catalog.models.length && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models
  try {
    const res = await fetch(`${BASE}/v1/models`, {
      headers: { accept: "application/json" },
      signal,
    })
    if (!res.ok) throw new Error(`catalog answered ${res.status}`)
    const models = parseListing(await res.json())
    if (models.length) {
      catalog = { at: Date.now(), models }
      return models
    }
  } catch {
    // An unreachable catalog is not a failed turn: the fallback list is
    // what the gateway served when this plugin was written.
  }
  return catalog.models.length ? catalog.models : normalizeFallback()
}

// modelIds is the catalog as a set, so a request can be checked against it
// without a second read.
async function modelIds(signal) {
  const models = await readCatalog(signal)
  return new Set(models.map((m) => m.id))
}

// expired makes an error magpie reads as "this account is done".
//
// The host looks for `signIn` on a thrown error (`host:2373`) and marks the
// account, which is what takes it out of rotation. Without it the refusal
// reaches magpie as text naming no status, and magpie answers a failure it
// cannot classify with 502 — which is temporary, so the account stays in
// rotation and every turn handed to it fails the same way.
function expired(message) {
  const e = new Error(message)
  e.signIn = "expired"
  return e
}

// requestKey is the account this fetch is running for. The loader is called
// in the account's scope, so `getAuth` returns that account's credential
// and the book names it by a hash of its key.
function keyIdOf(auth) {
  return idOf(auth?.key ?? "")
}

export const LovableAuth = async (_input, options = {}) => {
  const store = getBook(options)

  return {
    auth: {
      provider: ID,

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const id = keyIdOf(auth)

        // A retired key is answered without reaching the vendor: the turn
        // fails either way, and failing here is what tells magpie to stop
        // routing to it.
        if (store.retired(id)) {
          return {
            baseURL: BASE,
            apiKey: "lovable",
            async fetch() {
              throw expired(
                `lovable key ${id} is out of credits (402 payment_required); ` +
                  `Lovable does not lift it — remove the key or add another`,
              )
            },
          }
        }

        return {
          baseURL: BASE,
          apiKey: "lovable", // the fetch sets the real credential itself
          async fetch(init_, init = {}) {
            const url = typeof init_ === "string" ? init_ : init_ instanceof URL ? init_.href : init_.url
            const out = new Headers(init.headers ?? {})

            // 1. the key, always this account's — magpie built the header
            //    from the placeholder apiKey above
            out.set("authorization", `Bearer ${auth.key}`)
            out.delete("x-api-key")

            // 2. the beta headers the gateway refuses. Claude Code sends
            //    eight; three are read. One it does not know fails the
            //    whole request, so unknown ones are dropped rather than
            //    passed on.
            const betas = filterBetas(out.get("anthropic-beta"))
            if (betas) out.set("anthropic-beta", betas)
            else out.delete("anthropic-beta")

            // 3. the body fields it refuses with them
            const scrubbed = scrubBody(init.body)

            let res
            try {
              res = await fetch(url, { ...init, headers: out, body: scrubbed.body })
            } catch (e) {
              store.record(id, 0)
              throw e
            }

            store.record(id, res.status)

            // 4. a 402 is the account's, not the key's, and it does not
            //    lift. Two keys of one account both answer it, and no
            //    amount of waiting changes it. Mark the account and hand
            //    magpie the ending it knows how to act on.
            if (res.status === 402) {
              store.retire(id, "out of credits")
              store.flush()
              throw expired(
                `lovable key ${id}: 402 payment_required — this account has no credits left`,
              )
            }

            return res
          },
        }
      },

      // usage is what `magpie quota lovable` and the app's account row show.
      //
      // There is no allowance to read: Lovable publishes no endpoint for
      // it. What is reported is the book — requests, successes, the rate
      // limits, and whether the account is gone.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "no key", signIn: "kept" }
        const id = keyIdOf(auth)
        return describe(id, store.entries[id])
      },
    },

    // config declares the provider so magpie knows it before the first
    // listing lands. `provider.models` replaces these entries when the
    // gateway answers.
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      const models = normalizeFallback()
      config.provider[ID] = {
        name: "Lovable",
        npm: "@ai-sdk/anthropic",
        api: BASE,
        ...was,
        models: {
          ...Object.fromEntries(models.map((m) => [m.id, configModel(m)])),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: ID,

      // models is the gateway's own catalog, read once and cached. It
      // REPLACES what magpie built from config rather than merging into
      // it, so every field magpie draws from is carried through.
      async models(provider) {
        try {
          const models = await readCatalog()
          if (!models.length) return provider.models
          return Object.fromEntries(models.map((m) => [m.id, runtimeModel(m)]))
        } catch {
          return provider.models
        }
      },
    },
  }
}

// The pieces worth testing on their own, without a magpie around them.
export const _internal = { readCatalog, modelIds, expired, keyIdOf }
export { filterBetas, scrubBody, parseListing, normalizeFallback, Book, idOf, describe }
export default LovableAuth
