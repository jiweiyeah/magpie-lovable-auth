#!/usr/bin/env node
// Add a batch of Lovable keys to magpie as one provider's accounts.
//
//   magpie-lovable-import keys.txt
//   magpie-lovable-import sk_a…,sk_b…,sk_c…
//   cat keys.txt | magpie-lovable-import -
//
// `magpie plugin login lovable` is one prompt per key. This is the same
// thing for a file, with the two mistakes a batch makes silently caught:
// the same key twice, and a key that lost its last characters on the way
// through a terminal.
//
// It writes the same file the plugin host writes, under the same lock, so
// a host that is running when this runs does not write its own newer
// changes away with what it read before.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { classify, mask, parseKeys, readSource } from "../src/import.mjs"

const PROVIDER = "lovable"
const AUTH_PATH = process.env.MAGPIE_AUTH_PATH ?? path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
const LOCK_STALE_MS = 10_000

// The host's own lock, byte for byte: a lock this process holds is one the
// host waits on, and the other way round.
function lock(file) {
  const lockPath = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx", 0o600))
      return () => {
        try {
          fs.unlinkSync(lockPath)
        } catch {}
      }
    } catch (e) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM" && e?.code !== "EACCES") throw e
    }
    let stale = false
    try {
      stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS
    } catch {}
    if (stale || Date.now() - start > 2 * LOCK_STALE_MS) {
      try {
        fs.unlinkSync(lockPath)
      } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

function readAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
  } catch {}
  return {}
}

// writeDurable replaces the file through a temp file flushed to disk
// before the rename, as the host does: a rename reaches the disk on its
// own schedule and a machine that went down between the two left the file
// all zero.
function writeDurable(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, "w", 0o600)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

// nameFor is where a new key goes: the provider id while it is free, then
// `lovable#abc123`, as the host names its own accounts.
function nameFor(all, provider) {
  if (!(provider in all)) return provider
  for (;;) {
    const k = `${provider}#${Math.random().toString(36).slice(2, 8)}`
    if (!(k in all)) return k
  }
}

function main(argv) {
  const args = argv.slice(2).filter((a) => a !== "--dry-run")
  const dryRun = argv.includes("--dry-run")
  const source = args[0]
  if (!source) {
    console.error("usage: magpie-lovable-import <file|list|-> [--dry-run]")
    return 2
  }

  const text = readSource(source)
  const candidates = parseKeys(text)
  if (!candidates.length) {
    console.error("no keys found in that source")
    return 1
  }

  // Every key already in the pool, under this provider or any other: a
  // key added under one provider and again under another is one account
  // magpie routes to twice.
  const all = readAuth()
  const existing = new Set(Object.values(all).map((a) => a?.key).filter((k) => typeof k === "string"))
  const { fresh, duplicates, invalid } = classify(candidates, existing)

  for (const d of duplicates) console.log(`skip   ${mask(d.key)}  ${d.reason}`)
  for (const v of invalid) console.log(`refuse ${mask(v.key)}  ${v.reason}`)

  if (!fresh.length) {
    console.log(`\n0 added · ${duplicates.length} duplicate · ${invalid.length} invalid`)
    return invalid.length ? 1 : 0
  }
  if (dryRun) {
    for (const k of fresh) console.log(`would add ${mask(k)}`)
    console.log(`\n${fresh.length} would be added (dry run, nothing written)`)
    return 0
  }

  const unlock = lock(AUTH_PATH)
  try {
    const current = readAuth()
    // The file may have changed since it was read above (a host signing
    // in while this ran). Dedupe again against what is there now.
    const present = new Set(Object.values(current).map((a) => a?.key).filter((k) => typeof k === "string"))
    let added = 0
    for (const key of fresh) {
      if (present.has(key)) {
        console.log(`skip   ${mask(key)}  already in the pool`)
        continue
      }
      const name = nameFor(current, PROVIDER)
      current[name] = { type: "api", key }
      present.add(key)
      added++
      console.log(`add    ${mask(key)}  as ${name}`)
    }
    if (added) {
      writeDurable(AUTH_PATH, JSON.stringify(current, null, 2) + "\n")
    }
    console.log(`\n${added} added · ${duplicates.length} duplicate · ${invalid.length} invalid`)
  } finally {
    unlock()
  }
  console.log(`restart magpie (or reopen it) so the new accounts are read`)
  return invalid.length ? 1 : 0
}

process.exit(main(process.argv))
