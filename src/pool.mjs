// A key pool larger than the accounts magpie can carry.
//
// magpie's account model is static: every key is an account, every account
// is a row in the UI, and a provider with a thousand of them is a provider
// whose page takes sixteen seconds and whose gateway times out (measured:
// 21 accounts answer in 2s, 1771 do not answer at all).
//
// So the accounts magpie sees are *slots*, not keys. A slot is an account
// with no key of its own; the pool hands it one per request. magpie routes
// over N slots, the pool rotates over however many keys there are, and the
// UI shows N rows.
//
// What a slot is NOT: a claim that the pool's keys are interchangeable.
// Lovable's allowance is the account's, not the key's, so a pool of keys
// from one Lovable account has the capacity of one. The pool cannot know
// which keys share an account — that is a property of how they were made —
// so it treats them as separate and lets a 402 say otherwise.

import fs from "node:fs"
import path from "node:path"

import { Book, idOf } from "./keys.mjs"
import { keyProblem } from "./import.mjs"

// A key rests this long after a 429. Lovable's limit lifts in about a
// minute, and a key tried again before that only spends the retry.
const RATE_LIMIT_REST_MS = 60 * 1000

// A key that fails for a reason that is not about the account (a network
// blip, a 500) is tried again, but not forever: after this many it rests
// with the others for a while rather than being handed every request.
const FAILURE_REST_MS = 30 * 1000
const FAILURES_BEFORE_REST = 3

// How often `take` looks at the key file's mtime. A key added with the
// pool CLI must be in rotation without restarting magpie — the plugin host
// is long-lived — but a stat per request is more often than a file changes.
const RELOAD_CHECK_MS = 2 * 1000

export class Pool {
  constructor(file, { restMs = RATE_LIMIT_REST_MS } = {}) {
    this.file = file
    this.restMs = restMs
    this.keys = []          // the keys, in the order they were added
    this.cursor = 0         // round-robin position
    this.resting = new Map() // key id → the instant it may be tried again
    // The book sits beside the key file and is named after it: a pool's
    // key file is `lovable-keys.txt`, so its book is
    // `lovable-keys-book.json`. Deriving it by stripping `.json` would
    // leave a `.txt` pool writing its book over its own key file.
    this.book = new Book(`${file}.book.json`)
    this.seenAt = 0          // when the file's mtime was last looked at
    this.load()
    // what was just read is not stale: without this the first `take` after
    // start would re-read the file for nothing
    try {
      this.seenMtimeMs = fs.statSync(file).mtimeMs
    } catch {
      this.seenMtimeMs = 0
    }
  }

  // load reads the key file: one key per line, blank lines and `#` skipped.
  // The file is the pool's whole state — a key that is not in it is not in
  // the pool — so it is re-read on every change rather than kept in memory
  // alone.
  load() {
    let text = ""
    try {
      text = fs.readFileSync(this.file, "utf8")
    } catch {
      this.keys = []
      return
    }
    const seen = new Set()
    const keys = []
    for (const line of text.split(/\r?\n/)) {
      const k = line.trim()
      if (!k || k.startsWith("#")) continue
      if (keyProblem(k)) continue
      if (seen.has(k)) continue
      seen.add(k)
      keys.push(k)
    }
    this.keys = keys
  }

  // reload is load with the cursor kept in range.
  reload() {
    const was = this.keys.length
    this.load()
    if (this.cursor >= this.keys.length) this.cursor = 0
    return this.keys.length - was
  }

  // refresh re-reads the key file when its mtime moved. It is what makes a
  // key added by the CLI usable on the next request rather than the next
  // restart: the plugin host is long-lived and nothing else tells it the
  // file changed. Cheap enough to call from `take` — a stat every
  // RELOAD_CHECK_MS, not per request.
  refresh(now = Date.now()) {
    if (now - this.seenAt < RELOAD_CHECK_MS) return 0
    this.seenAt = now
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs
    } catch {
      return 0
    }
    if (mtimeMs === this.seenMtimeMs) return 0
    this.seenMtimeMs = mtimeMs
    return this.reload()
  }

  size() {
    return this.keys.length
  }

  // live is the keys that may be tried now: not retired, not resting.
  live(now = Date.now()) {
    const out = []
    for (const k of this.keys) {
      const id = idOf(k)
      if (this.book.retired(id)) continue
      const until = this.resting.get(id)
      if (until && until > now) continue
      out.push(k)
    }
    return out
  }

  // take hands out the next live key, round-robin, and says which one.
  //
  // A pool with nothing live answers null rather than a key that will
  // fail: the caller says what that means (every key out of credits, or
  // every key resting) rather than spending a request to find out.
  take(now = Date.now()) {
    // a key the CLI added a moment ago is in rotation now, not after a
    // restart of a host that runs for days
    this.refresh(now)
    const live = this.live(now)
    if (!live.length) return null
    // The cursor counts over the whole pool, not over what is live now: a
    // key that retires must not shift every other key's turn, and a pool
    // that shrinks to one must not keep answering with that one forever
    // because the modulo landed there.
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length
      const key = this.keys[idx]
      if (live.includes(key)) {
        this.cursor = (idx + 1) % this.keys.length
        return key
      }
    }
    return null
  }

  // note records what a key answered and moves it in or out of rotation.
  note(key, status, now = Date.now()) {
    const id = idOf(key)
    const e = this.book.record(id, status, now)
    if (status === 402) {
      // the account's, not the key's, and it does not lift
      this.book.retire(id, "out of credits", now)
      this.book.flush()
    } else if (status === 401) {
      // "Invalid API key. The key could not be decrypted." — a truncated
      // copy or a key Lovable no longer holds. Waiting does not fix it and
      // trying it again only spends a request, so it goes the way a 402
      // does. (Measured: a made-up key of the right shape answers 401.)
      this.book.retire(id, "invalid", now)
      this.book.flush()
    } else if (status === 429) {
      this.resting.set(id, now + this.restMs)
    } else if (status >= 500 || status === 0) {
      // a failure that is not about the account: rest it after a few,
      // rather than hand it every request
      if (e.failures >= FAILURES_BEFORE_REST) this.resting.set(id, now + FAILURE_REST_MS)
    } else if (status >= 200 && status < 400) {
      this.resting.delete(id)
    }
    return e
  }

  // summary is what the account row shows for a slot.
  summary(now = Date.now()) {
    const total = this.keys.length
    const live = this.live(now).length
    const retired = this.keys.filter((k) => this.book.retired(idOf(k))).length
    return { total, live, resting: total - live - retired, retired }
  }

  // reasons counts the retirements by why. The row shows both: a key out of
  // credits and a key Lovable no longer holds both stop working, and which
  // one it was is the difference between "the pool is being spent" and
  // "something is feeding the pool junk".
  reasons() {
    const out = {}
    for (const k of this.keys) {
      const e = this.book.entries[idOf(k)]
      if (!e?.retiredAt) continue
      const why = e.retiredReason || "retired"
      out[why] = (out[why] ?? 0) + 1
    }
    return out
  }

  // sync rewrites the key file from a list, keeping its order and dropping
  // duplicates. Used by the importer when it moves keys into a pool.
  static write(file, keys) {
    const seen = new Set()
    const out = []
    for (const k of keys) {
      if (!k || seen.has(k) || keyProblem(k)) continue
      seen.add(k)
      out.push(k)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, out.join("\n") + "\n")
    return out.length
  }
}

// poolFile is where a provider's pool lives: beside the plugin's own files,
// named for the provider so two providers do not share one.
export function poolFile(dir, provider) {
  return path.join(dir, `${provider}-keys.txt`)
}
