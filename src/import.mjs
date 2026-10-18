// Importing a batch of keys.
//
// A pool is grown a key at a time by `magpie plugin login lovable`, which
// is one prompt per key. A batch is what someone with forty keys actually
// has, so this takes a file, a comma list, or standard input.
//
// Two things a batch has to get right, and both are silent when wrong:
//
//   * dedupe. The same key pasted twice is two accounts to magpie, so a
//     turn routed to the second one is a turn spent on a key already in
//     the pool. The comparison is on the whole key, not a prefix: two keys
//     of one account share a prefix and differ at the end.
//
//   * validate. A truncated key — a copy that lost its last characters,
//     which a terminal does quietly — authenticates as nothing and answers
//     401 on every turn it is given. It is refused here rather than added
//     and discovered later.
//
// The file is read from a path, never from the plugin's own directory, and
// is never copied: what is kept is the key, in plugin-auth.json, the same
// place a single sign-in goes.

import fs from "node:fs"

// A Lovable gateway key is 267 characters: `sk_` and 264 base64
// characters, measured on the keys this gateway mints.
//
// The length is the part that catches a truncated paste: a copy that lost
// its tail is still all base64, so an alphabet check passes it and the key
// authenticates as nothing. A short key is refused rather than added and
// discovered on the turn it is handed.
export const KEY_PREFIX = /^sk_[A-Za-z0-9+/=]+$/
export const KEY_LENGTH = 267
export const KEY_BODY_LENGTH = KEY_LENGTH - 3

// KEY_PATTERN is both, for a caller that wants one test.
export const KEY_PATTERN = /^sk_[A-Za-z0-9+/=]{264}$/

// keyProblem says what is wrong with a candidate, or "" when nothing is.
export function keyProblem(key) {
  if (typeof key !== "string" || !key) return "not a key (no sk_ prefix)"
  if (!KEY_PREFIX.test(key)) return "not a key (no sk_ prefix)"
  if (key.length < KEY_LENGTH) return `truncated (${key.length} of ${KEY_LENGTH} characters)`
  if (key.length > KEY_LENGTH) return `too long (${key.length} of ${KEY_LENGTH} characters)`
  return ""
}

// parseKeys turns a blob of text into candidate keys.
//
// One per line, or comma/space separated, with quotes and surrounding
// punctuation tolerated — a key pasted out of a JSON file arrives as
// `"sk_…",`. Comments (`#`) and blank lines are skipped.
export function parseKeys(text) {
  if (typeof text !== "string" || !text) return []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    // a whole-line comment, before the line is split on commas: a key is
    // never on a commented line
    if (/^\s*#/.test(line)) continue
    for (const raw of line.split(/[\s,]+/)) {
      const token = raw.replace(/^["'`\[]+|["'`\],;]+$/g, "").trim()
      if (!token) continue
      out.push(token)
    }
  }
  return out
}

// ledgerKeys reads a registration ledger — one JSON object per line — and
// returns the keys in it worth adding.
//
// The ledger this is written for is a registration pipeline's: a row per
// account with `api_key`, `success`, `key_dead` and a few dozen other
// fields. Only three of them matter here, and each excludes a row for its
// own reason:
//
//   success: false    the registration did not finish, so there is no key
//   key_dead: true    the vendor has since refused it
//   api_key empty     a row that names no key
//
// A key that is `key_dead` is skipped rather than added and discovered on
// the first turn handed to it. A row that says nothing about either field
// is taken as usable: an older ledger does not have them.
export function ledgerKeys(text) {
  if (typeof text !== "string" || !text) return { keys: [], skipped: [] }
  const keys = []
  const skipped = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      skipped.push({ key: "", reason: "a line that is not JSON" })
      continue
    }
    if (!row || typeof row !== "object") {
      skipped.push({ key: "", reason: "a line that is not an object" })
      continue
    }
    const key = typeof row.api_key === "string" ? row.api_key.trim() : ""
    if (!key) {
      skipped.push({ key: "", reason: "a row with no api_key" })
      continue
    }
    if (row.success === false) {
      skipped.push({ key, reason: "the registration did not succeed" })
      continue
    }
    if (row.key_dead === true) {
      skipped.push({ key, reason: "marked key_dead" })
      continue
    }
    keys.push(key)
  }
  return { keys, skipped }
}

// classify splits a batch into what can be added and what cannot, with a
// reason for each refusal.
//
// `existing` is the set of keys already in the pool. A key that is in it is
// a duplicate, not an error: adding it again would make magpie route to a
// second account that is the same account.
export function classify(candidates, existing = new Set()) {
  const seen = new Set()
  const fresh = []
  const duplicates = []
  const invalid = []
  for (const key of candidates) {
    const problem = keyProblem(key)
    if (problem) {
      invalid.push({ key, reason: problem })
      continue
    }
    if (existing.has(key)) {
      duplicates.push({ key, reason: "already in the pool" })
      continue
    }
    if (seen.has(key)) {
      duplicates.push({ key, reason: "repeated in the batch" })
      continue
    }
    seen.add(key)
    fresh.push(key)
  }
  return { fresh, duplicates, invalid }
}

// readSource is the batch from whatever the user named: a path, a literal
// list, or standard input (`-`).
export function readSource(source) {
  if (!source || source === "-") {
    if (source === "-") return fs.readFileSync(0, "utf8")
    return ""
  }
  try {
    const stat = fs.statSync(source)
    if (stat.isFile()) return fs.readFileSync(source, "utf8")
  } catch {
    // not a path: a literal list
  }
  return source
}

// mask is a key as a person may see it in a report: enough to tell two
// apart, not enough to use.
export function mask(key) {
  if (typeof key !== "string" || key.length < 12) return "…"
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}
