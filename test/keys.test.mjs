import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Book, idOf, describe } from "../src/keys.mjs"

function tempBook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lovable-book-"))
  return { dir, file: path.join(dir, "book.json"), book: new Book(path.join(dir, "book.json")) }
}

test("idOf names a key without writing it", () => {
  const key = "sk_" + "a".repeat(263)
  const id = idOf(key)
  assert.match(id, /^[0-9a-f]{8}$/)
  assert.equal(idOf(key), id, "the same key lands on one row")
  assert.notEqual(idOf(key), idOf(key.slice(0, -1) + "b"), "two keys never collide")
  assert.equal(idOf(""), "")
})

test("a fresh key is booked with nothing against it", () => {
  const { book } = tempBook()
  assert.equal(book.entries["abcd1234"], undefined)
  const e = book.entry("abcd1234")
  assert.equal(e.requests, 0)
  assert.equal(book.retired("abcd1234"), false)
})

test("a success is counted, a 429 is a rate not an ending", () => {
  const { book } = tempBook()
  book.record("k1", 200)
  book.record("k1", 429)
  book.record("k1", 500)
  const e = book.entries["k1"]
  assert.equal(e.requests, 3)
  assert.equal(e.ok, 1)
  assert.equal(e.rateLimited, 1)
  assert.equal(e.failures, 1)
  assert.equal(book.retired("k1"), false, "a rate limit does not retire a key")
})

test("a 402 retires the account for good", () => {
  const { book } = tempBook()
  book.record("k2", 402)
  book.retire("k2", "out of credits")
  assert.equal(book.retired("k2"), true)
  const again = book.retire("k2", "something else")
  assert.equal(again.retiredReason, "out of credits", "the first reason is the one kept")
})

test("the book survives a restart", () => {
  const { file } = tempBook()
  const a = new Book(file)
  a.record("k3", 200)
  a.retire("k3", "out of credits")
  a.flush()

  const b = new Book(file)
  assert.equal(b.entries["k3"].ok, 1)
  assert.equal(b.retired("k3"), true)
})

test("a corrupt book is not a crash", () => {
  const { file } = tempBook()
  fs.writeFileSync(file, "{not json")
  const b = new Book(file)
  assert.deepEqual(b.entries, {})
  b.record("k4", 200)
  assert.equal(b.entries["k4"].ok, 1)
})

test("describe says a retired key is gone, and that signing in again will not help", () => {
  const { book } = tempBook()
  book.record("k5", 402)
  book.retire("k5", "out of credits")
  const d = describe("k5", book.entries["k5"])
  assert.equal(d.signIn, "expired", "magpie reads this to take the account out")
  assert.match(d.plan, /no credits left/)
  assert.match(d.error, /402 payment_required/)
  // magpie's own wording for a lapsed sign-in is "sign in again", which for
  // an account out of credits is the one instruction that cannot work
  assert.match(d.error, /Signing in again will not help/)
  assert.match(d.error, /shares the same balance/)
})

test("describe names a working key by what it has done", () => {
  const { book } = tempBook()
  book.record("k6", 200)
  book.record("k6", 200)
  book.record("k6", 429)
  const d = describe("k6", book.entries["k6"])
  assert.equal(d.signIn, "kept")
  assert.match(d.plan, /2\/3 ok/)
  assert.match(d.plan, /1 rate-limited/)
  assert.equal(d.renew, "auto")
})

test("describe says a key that never answered has not", () => {
  const { book } = tempBook()
  book.record("k7", 500)
  const d = describe("k7", book.entries["k7"])
  assert.equal(d.renew, "off")
  assert.match(d.error, /no successful request/)
})
