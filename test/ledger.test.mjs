import test from "node:test"
import assert from "node:assert/strict"

import { ledgerKeys } from "../src/import.mjs"

const KEY_A = "sk_" + "A".repeat(264)
const KEY_B = "sk_" + "B".repeat(264)
const KEY_C = "sk_" + "C".repeat(264)

const row = (o) => JSON.stringify(o)

test("a ledger's keys are read from its rows", () => {
  const text = [
    row({ email: "a@x", api_key: KEY_A, success: true, key_dead: false }),
    row({ email: "b@x", api_key: KEY_B, success: true }),
  ].join("\n")
  const { keys, skipped } = ledgerKeys(text)
  assert.deepEqual(keys, [KEY_A, KEY_B])
  assert.deepEqual(skipped, [])
})

test("a registration that did not succeed is skipped", () => {
  const text = row({ api_key: KEY_A, success: false })
  const { keys, skipped } = ledgerKeys(text)
  assert.deepEqual(keys, [])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /did not succeed/)
})

test("a key the vendor has refused is skipped, not added", () => {
  // the failure this exists for: adding a dead key means magpie routes to
  // it and every turn handed to it fails
  const text = row({ api_key: KEY_A, success: true, key_dead: true })
  const { keys, skipped } = ledgerKeys(text)
  assert.deepEqual(keys, [])
  assert.match(skipped[0].reason, /key_dead/)
})

test("a row with no key is skipped", () => {
  const text = [row({ email: "a@x", success: true }), row({ api_key: "", success: true })].join("\n")
  const { keys, skipped } = ledgerKeys(text)
  assert.deepEqual(keys, [])
  assert.equal(skipped.length, 2)
})

test("a row that says nothing about either field is taken as usable", () => {
  // an older ledger does not carry success or key_dead
  const text = row({ email: "a@x", api_key: KEY_A })
  const { keys } = ledgerKeys(text)
  assert.deepEqual(keys, [KEY_A])
})

test("blank lines are skipped silently, a bad line is reported", () => {
  const text = ["", row({ api_key: KEY_A }), "", "not json", ""].join("\n")
  const { keys, skipped } = ledgerKeys(text)
  assert.deepEqual(keys, [KEY_A])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /not JSON/)
})

test("the whole ledger's worth of rows comes through in order", () => {
  const text = [KEY_A, KEY_B, KEY_C].map((k, i) => row({ n: i, api_key: k, success: true })).join("\n")
  const { keys } = ledgerKeys(text)
  assert.deepEqual(keys, [KEY_A, KEY_B, KEY_C])
})

test("nothing in, nothing out", () => {
  assert.deepEqual(ledgerKeys(""), { keys: [], skipped: [] })
  assert.deepEqual(ledgerKeys(undefined), { keys: [], skipped: [] })
})
