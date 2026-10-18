#!/usr/bin/env node
// Manage a Lovable key pool and the slots magpie routes over.
//
//   magpie-lovable-pool load keys.txt     put keys into the pool
//   magpie-lovable-pool load ledger.jsonl --ledger
//   magpie-lovable-pool status            what the pool holds
//   magpie-lovable-pool slots 8           make magpie see 8 slots
//   magpie-lovable-pool slots 0           remove every slot
//
// Why slots at all: magpie's account list is static, one row per account,
// and a provider carrying 1771 of them takes sixteen seconds to draw and
// does not answer requests at all (measured). A slot is an account with no
// key of its own — the plugin hands it one from the pool per request — so
// magpie sees `slots` rows however many keys the pool holds.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Pool } from "../src/pool.mjs"
import { classify, ledgerKeys, mask, parseKeys, readSource } from "../src/import.mjs"

const PROVIDER = "lovable"
const HERE = path.dirname(fileURLToPath(import.meta.url))
const POOL_FILE = process.env.LOVABLE_POOL_FILE ?? path.join(HERE, "..", ".lovable-pool.txt")
const AUTH_PATH = process.env.MAGPIE_AUTH_PATH ?? path.join(os.homedir(), ".config", "magpie", "plugin-auth.json")
const LOCK_STALE_MS = 10_000

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

const slotName = (i) => (i === 0 ? PROVIDER : `${PROVIDER}#s${i}`)

function cmdLoad(argv) {
  const args = argv.filter((a) => !a.startsWith("--"))
  const ledger = argv.includes("--ledger")
  const source = args[0]
  if (!source) {
    console.error("usage: magpie-lovable-pool load <file|list|-> [--ledger] [--dry-run]")
    return 2
  }
  const text = readSource(source)
  const read = ledger ? ledgerKeys(text) : { keys: parseKeys(text), skipped: [] }
  const pool = new Pool(POOL_FILE)
  const existing = new Set(pool.keys)
  const { fresh, duplicates, invalid } = classify(read.keys, existing)

  for (const s of read.skipped) console.log(`skip   ${mask(s.key)}  ${s.reason}`)
  for (const d of duplicates) console.log(`skip   ${mask(d.key)}  ${d.reason}`)
  for (const v of invalid) console.log(`refuse ${mask(v.key)}  ${v.reason}`)

  if (argv.includes("--dry-run")) {
    console.log(`\n${fresh.length} would be added · ${duplicates.length} duplicate · ${invalid.length} invalid`)
    return 0
  }
  if (!fresh.length) {
    console.log(`\n0 added · ${duplicates.length} duplicate · ${invalid.length} invalid`)
    return 0
  }

  const all = [...pool.keys, ...fresh]
  Pool.write(POOL_FILE, all)
  console.log(`\n${fresh.length} added · ${duplicates.length} duplicate · ${invalid.length} invalid`)
  console.log(`pool now holds ${all.length} keys in ${POOL_FILE}`)
  return 0
}

function cmdStatus() {
  const pool = new Pool(POOL_FILE)
  const s = pool.summary()
  console.log(`pool      ${POOL_FILE}`)
  console.log(`keys      ${s.total} total · ${s.live} live · ${s.resting} resting · ${s.retired} retired`)
  for (const [why, n] of Object.entries(pool.reasons()).sort((a, b) => b[1] - a[1])) {
    console.log(`          ${n} ${why}`)
  }

  const all = readAuth()
  const slots = Object.keys(all).filter((k) => k === PROVIDER || k.startsWith(`${PROVIDER}#`)).filter((k) => all[k]?.pool === true)
  console.log(`slots     ${slots.length}${slots.length ? ` (${slots.join(", ")})` : ""}`)

  // what magpie actually routes over: slots plus any real-key accounts
  const real = Object.keys(all).filter((k) => (k === PROVIDER || k.startsWith(`${PROVIDER}#`)) && all[k]?.pool !== true)
  if (real.length) console.log(`old keys  ${real.length} accounts still carrying their own key — remove them once the pool is in use`)
  return 0
}

function cmdSlots(argv) {
  const n = Number(argv.filter((a) => !a.startsWith("--"))[0])
  if (!Number.isInteger(n) || n < 0) {
    console.error("usage: magpie-lovable-pool slots <n>")
    return 2
  }
  const pool = new Pool(POOL_FILE)
  if (n > 0 && pool.size() === 0) {
    console.error(`the pool is empty — load keys first (magpie-lovable-pool load <file>)`)
    return 1
  }

  const unlock = lock(AUTH_PATH)
  try {
    const all = readAuth()
    // every account of this provider that carries its own key is one the
    // slots replace; leaving one behind means magpie routes some turns to
    // a key the pool never sees
    for (const k of Object.keys(all)) {
      if ((k === PROVIDER || k.startsWith(`${PROVIDER}#`)) && all[k]?.pool !== true) delete all[k]
    }
    for (let i = 0; i < n; i++) all[slotName(i)] = { type: "api", key: "", pool: true }
    writeDurable(AUTH_PATH, JSON.stringify(all, null, 2) + "\n")
    console.log(`${n} slot${n === 1 ? "" : "s"} written (${n ? Array.from({ length: n }, (_, i) => slotName(i)).join(", ") : "none"})`)
    console.log(`the pool holds ${pool.size()} keys behind them`)
  } finally {
    unlock()
  }
  return 0
}

function main(argv) {
  const cmd = argv[2]
  const rest = argv.slice(3)
  switch (cmd) {
    case "load":
      return cmdLoad(rest)
    case "status":
      return cmdStatus()
    case "slots":
      return cmdSlots(rest)
    default:
      console.error("usage: magpie-lovable-pool <load|status|slots> [args]")
      return 2
  }
}

process.exit(main(process.argv))
