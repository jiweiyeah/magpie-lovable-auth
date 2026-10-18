// What a key is, and what happened to it.
//
// Lovable publishes no allowance endpoint: `/v1/credits`, `/v1/usage`,
// `/v1/me`, `/v1/balance`, `/v1/limits` and `/v1/quota` all answer 404, and
// no reply carries a `ratelimit-*` header. So the only reading of a key's
// health is what this plugin saw itself, and it has to keep it.
//
// What is worth keeping, and why:
//
//   * 402 `payment_required` is the account's, not the key's — two keys of
//     one account both answer it — and it does not lift. A key that got one
//     is out of rotation for good; leaving it in means every turn routed to
//     it fails, which is the loop a pool without this book falls into.
//
//   * 429 `rate_limited` is a rate, not an allowance. It lifts in about a
//     minute and the key stays.
//
// The book lives beside the plugin's credential file, one JSON document, and
// is written on a debounce so a fast turn does not rewrite it per request.

import fs from "node:fs"
import path from "node:path"

const WRITE_DELAY_MS = 2000

export class Book {
  constructor(file) {
    this.file = file
    this.entries = {}
    this.timer = null
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.entries = parsed
    } catch {
      this.entries = {}
    }
  }

  // entry returns the book's row for a key, made if absent. The key itself
  // is never written: a book that names it is a book that leaks it.
  entry(id) {
    return (this.entries[id] ??= {
      requests: 0,
      ok: 0,
      rateLimited: 0,
      outOfCredits: 0,
      failures: 0,
      lastStatus: 0,
      lastOkAt: 0,
      lastSeenAt: 0,
      retiredAt: 0,
      retiredReason: "",
    })
  }

  // retired says whether the account behind this key is gone for good.
  retired(id) {
    return !!this.entries[id]?.retiredAt
  }

  record(id, status, now = Date.now()) {
    const e = this.entry(id)
    e.requests++
    e.lastSeenAt = now
    e.lastStatus = status
    if (status >= 200 && status < 400) {
      e.ok++
      e.lastOkAt = now
    } else if (status === 429) {
      e.rateLimited++
    } else if (status === 402) {
      e.outOfCredits++
    } else if (status >= 400) {
      e.failures++
    }
    this.save()
    return e
  }

  retire(id, reason, now = Date.now()) {
    const e = this.entry(id)
    if (!e.retiredAt) {
      e.retiredAt = now
      e.retiredReason = reason
      this.save()
    }
    return e
  }

  // save debounces: a turn that makes a dozen requests writes once.
  save() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2))
    } catch {
      // A book that cannot be written is a report that is lost, not a
      // request that fails: the turn goes on.
    }
  }
}

// idOf is the stable, non-secret name a key is booked under.
//
// A key is 267 characters and must not be written to disk in a report, so
// the book names it by a short hash. The hash is of the key alone, so two
// runs of the same key land on one row and two keys never collide in
// practice.
export function idOf(key) {
  if (!key) return ""
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// describe is one key as magpie's account row and `magpie quota lovable`
// show it.
//
// `plan` is the one line the row shows beside the account's name, so it
// carries the reading that matters at a glance. The allowance itself
// cannot be read — Lovable publishes no endpoint for it — and a row that
// says nothing there renders "no allowance data", which reads as this
// plugin failing rather than as the vendor not saying. So the row says
// what it does know instead: how the key has answered, and when it last
// did.
//
// `windows` stays empty on purpose: a window without a `resetsAt` never
// lifts once it fills, so inventing one would park a working account.
export function describe(id, e) {
  if (!e) return { plan: "unused", signIn: "kept" }
  if (e.retiredAt) {
    return {
      plan: `retired · ${e.retiredReason}`,
      error: `key ${id} answered 402 payment_required and Lovable does not lift it — this account has no credits left`,
      signIn: "expired",
    }
  }
  const parts = [`${e.ok}/${e.requests} ok`]
  if (e.rateLimited) parts.push(`${e.rateLimited} rate-limited`)
  if (e.failures) parts.push(`${e.failures} failed`)
  const last = e.lastOkAt ? new Date(e.lastOkAt) : null
  // the last success goes in the plan line, not in `until`: magpie reads
  // `until` as the plan's renewal date and would say "renews <that day>",
  // which is a claim about the account that was never read.
  if (last) {
    const hhmm = `${String(last.getHours()).padStart(2, "0")}:${String(last.getMinutes()).padStart(2, "0")}`
    parts.push(`last ok ${hhmm}`)
  }
  return {
    plan: parts.join(" · "),
    user: `key ${id}`,
    // an account that has never answered is not an error — it may simply
    // not have been used yet — but it is worth saying, because it is the
    // one state a dead key and an idle one look alike in
    error: last ? undefined : "no successful request yet",
    windows: [],
    signIn: "kept",
    renew: last ? "auto" : "off",
  }
}
