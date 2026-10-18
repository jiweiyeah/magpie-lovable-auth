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
import { Pool } from "./pool.mjs"
import {
  BASE,
  configModel,
  normalizeFallback,
  parseListing,
  runtimeModel,
} from "./models.mjs"

const ID = "lovable"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOOK_FILE = path.join(HERE, "..", ".lovable-book.json")
const POOL_FILE = path.join(HERE, "..", ".lovable-pool.txt")

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

// One pool per process, made on first use. Its key file is beside the
// plugin's own files; `options.poolFile` names another.
let pool
function getPool(options) {
  if (!pool) pool = new Pool(options?.poolFile ?? POOL_FILE, { restMs: options?.restMs })
  return pool
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

// poolLoader is a slot's loader: the account has no key of its own, and
// every request takes one from the pool.
//
// Two things it does that the single-key path does not:
//
//   * a request that finds no live key answers without reaching the
//     vendor. Saying "every key is out of credits" costs nothing and is
//     the truth; spending a request to be told 402 again is not.
//
//   * a 402 retires THAT key and the request is answered 502, not
//     `signIn: expired`. The account magpie routes to is the slot, and
//     the slot is not out of credits — one key in its pool is. Retiring
//     the slot would take a working pool out of rotation over one dead
//     key.
function poolLoader(pool) {
  return {
    baseURL: `${BASE}/v1`,
    apiKey: "lovable", // the fetch sets the real credential itself
    async fetch(init_, init = {}) {
      const url = typeof init_ === "string" ? init_ : init_ instanceof URL ? init_.href : init_.url
      const key = pool.take()
      if (!key) {
        const s = pool.summary()
        throw new Error(
          `lovable pool has no key to try: ${s.total} keys, ${s.retired} out of credits, ${s.resting} resting`,
        )
      }

      const out = new Headers(init.headers ?? {})
      out.set("authorization", `Bearer ${key}`)
      out.delete("x-api-key")

      const betas = filterBetas(out.get("anthropic-beta"))
      if (betas) out.set("anthropic-beta", betas)
      else out.delete("anthropic-beta")

      const scrubbed = scrubBody(init.body)

      let res
      try {
        res = await fetch(url, { ...init, headers: out, body: scrubbed.body })
      } catch (e) {
        pool.note(key, 0)
        throw e
      }

      pool.note(key, res.status)

      // A 402 is that key's account, and it is retired by `note`. The
      // slot keeps its place in rotation: the next request takes another
      // key. Handing magpie `signIn: expired` here would take the whole
      // slot — and every key behind it — out over one dead key.
      if (res.status === 402) {
        const s = pool.summary()
        throw new Error(
          `lovable key ${idOf(key)} is out of credits; retired. ` +
            `pool now: ${s.live} live of ${s.total} (${s.retired} retired, ${s.resting} resting)`,
        )
      }

      return res
    },
  }
}

const LovableAuth = async (_input, options = {}) => {
  const store = getBook(options)
  const pool = getPool(options)

  return {
    auth: {
      provider: ID,

      async loader(getAuth) {
        const auth = await getAuth()

        // A SLOT is an account whose key is the pool's, not its own.
        //
        // magpie's account list is static and every account is a row, so a
        // pool of a thousand keys carried as a thousand accounts makes the
        // provider page take sixteen seconds and the gateway time out
        // (measured). A slot says `pool: true` and carries no key of its
        // own; the fetch takes one from the pool per request. magpie sees
        // as many rows as there are slots, however many keys there are.
        //
        // Checked before the key test: a slot has no key, and a loader that
        // returns `{}` for it leaves magpie with no baseURL and no fetch —
        // which is a 404 on a path it built from nothing.
        if (auth?.type === "api" && auth.pool === true) return poolLoader(pool)

        if (auth?.type !== "api" || !auth.key) return {}

        const id = keyIdOf(auth)

        // A retired key is answered without reaching the vendor: the turn
        // fails either way, and failing here is what tells magpie to stop
        // routing to it.
        if (store.retired(id)) {
          return {
            baseURL: `${BASE}/v1`,
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
          // magpie appends the request's own path (`/messages`,
          // `/chat/completions`) to this, so the version prefix belongs
          // here — a baseURL without it sends `/messages` and the gateway
          // answers 404.
          baseURL: `${BASE}/v1`,
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
        if (auth?.type !== "api") return { error: "no key", signIn: "kept" }

        // A slot reports the pool, not itself: what it has is keys, and
        // how many of them can still be tried.
        if (auth.pool === true) {
          pool.reload()
          const s = pool.summary()
          if (!s.total) {
            return {
              plan: "pool is empty",
              error: "no keys in the pool — add some with magpie-lovable-import, or point it at a key file",
              signIn: "kept",
              windows: [],
            }
          }
          const parts = [`${s.live} live of ${s.total} keys`]
          if (s.retired) parts.push(`${s.retired} out of credits`)
          if (s.resting) parts.push(`${s.resting} resting`)
          return {
            plan: parts.join(" · "),
            user: "key pool",
            // a pool with every key retired is done; one with keys resting
            // is not, and says so by leaving this unset
            ...(s.live ? {} : { error: `no key can be tried: ${s.total} keys, ${s.retired} out of credits` }),
            windows: [],
            signIn: "kept",
          }
        }

        if (!auth.key) return { error: "no key", signIn: "kept" }
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

// Nothing else is exported from this file on purpose.
//
// magpie's plugin host treats every exported function as a plugin entry
// (`servers()` in the host walks `Object.values(mod)`), so a helper exported
// beside the plugin is called as one — a class export is called without
// `new` and the whole plugin fails to load. The pieces worth testing on
// their own are exported from their own modules instead.
export default LovableAuth
