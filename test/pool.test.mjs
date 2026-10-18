import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Pool } from "../src/pool.mjs"
import { idOf } from "../src/keys.mjs"

const K = (c) => "sk_" + c.repeat(264)
const A = K("A")
const B = K("B")
const C = K("C")

function tempPool(keys = [A, B, C]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-pool-"))
  const file = path.join(dir, "pool.txt")
  fs.writeFileSync(file, keys.join("\n") + "\n")
  return { dir, file, pool: new Pool(file) }
}

test("the pool reads its keys, one per line", () => {
  const { pool } = tempPool()
  assert.equal(pool.size(), 3)
  assert.deepEqual(pool.keys, [A, B, C])
})

test("a missing pool file is an empty pool, not a crash", () => {
  const pool = new Pool("/nonexistent/pool.txt")
  assert.equal(pool.size(), 0)
  assert.equal(pool.take(), null)
})

test("blank lines, comments and duplicates are skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-pool-"))
  const file = path.join(dir, "pool.txt")
  fs.writeFileSync(file, `# my keys\n\n${A}\n${A}\n${B}\n`)
  const pool = new Pool(file)
  assert.deepEqual(pool.keys, [A, B])
})

test("take hands out the keys round-robin", () => {
  const { pool } = tempPool()
  assert.equal(pool.take(), A)
  assert.equal(pool.take(), B)
  assert.equal(pool.take(), C)
  assert.equal(pool.take(), A, "and back around")
})

test("a key resting from a 429 is not handed out", () => {
  const { pool } = tempPool([A, B])
  const now = 1_000_000
  pool.note(A, 429, now)
  assert.equal(pool.take(now), B)
  assert.equal(pool.take(now), B, "the resting one is skipped every time")
})

test("a resting key comes back when its rest ends", () => {
  const { pool } = tempPool([A])
  pool.note(A, 429, 1_000_000)
  assert.equal(pool.take(1_000_000), null, "nothing live during the rest")
  assert.equal(pool.take(1_000_000 + 61_000), A, "and it is back after a minute")
})

test("a 402 retires the key for good", () => {
  const { pool } = tempPool([A, B])
  pool.note(A, 402)
  assert.equal(pool.take(), B)
  assert.equal(pool.take(), B, "the retired key is never handed out again")
  assert.equal(pool.summary().retired, 1)
})

test("a pool with nothing live says so instead of spending a request", () => {
  const { pool } = tempPool([A])
  pool.note(A, 402)
  assert.equal(pool.take(), null)
  const s = pool.summary()
  assert.equal(s.total, 1)
  assert.equal(s.retired, 1)
  assert.equal(s.live, 0)
})

test("a success clears a rest", () => {
  const { pool } = tempPool([A])
  pool.note(A, 429, 1_000_000)
  pool.resting.delete(idOf(A)) // as a later success would
  pool.note(A, 200, 1_000_000)
  assert.equal(pool.take(1_000_000), A)
})

test("repeated failures rest a key rather than trying it every time", () => {
  const { pool } = tempPool([A, B])
  const now = 1_000_000
  for (let i = 0; i < 3; i++) pool.note(A, 500, now)
  assert.equal(pool.take(now), B, "A rests after three failures")
})

test("the summary counts live, resting and retired", () => {
  const { pool } = tempPool([A, B, C])
  const now = 1_000_000
  pool.note(A, 402, now)
  pool.note(B, 429, now)
  const s = pool.summary(now)
  assert.deepEqual(s, { total: 3, live: 1, resting: 1, retired: 1 })
})

test("reload picks up keys added to the file", () => {
  const { file, pool } = tempPool([A])
  fs.appendFileSync(file, `${B}\n`)
  assert.equal(pool.reload(), 1)
  assert.equal(pool.size(), 2)
})

test("write drops duplicates and invalid keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-pool-"))
  const file = path.join(dir, "pool.txt")
  const n = Pool.write(file, [A, A, "junk", B, ""])
  assert.equal(n, 2)
  assert.deepEqual(new Pool(file).keys, [A, B])
})

test("a retired key stays retired across a restart", () => {
  const { file, pool } = tempPool([A, B])
  pool.note(A, 402)
  pool.book.flush()

  const again = new Pool(file)
  assert.equal(again.take(), B, "the book remembered the retirement")
})
