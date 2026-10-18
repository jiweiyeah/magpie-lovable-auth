import test from "node:test"
import assert from "node:assert/strict"

import { parseKeys, classify, mask, keyProblem, KEY_PATTERN, KEY_LENGTH } from "../src/import.mjs"

// A key as the gateway mints one: sk_ and 264 base64 characters, 267 in all.
const KEY_A = "sk_" + "A".repeat(264)
const KEY_B = "sk_" + "B".repeat(264)

test("one key per line", () => {
  assert.deepEqual(parseKeys(`${KEY_A}\n${KEY_B}\n`), [KEY_A, KEY_B])
})

test("a comma list, with quotes and JSON punctuation tolerated", () => {
  assert.deepEqual(parseKeys(`"${KEY_A}", '${KEY_B}',`), [KEY_A, KEY_B])
  assert.deepEqual(parseKeys(`["${KEY_A}", "${KEY_B}"]`), [KEY_A, KEY_B])
})

test("blank lines and comments are skipped", () => {
  assert.deepEqual(parseKeys(`# my keys\n\n${KEY_A}\n  \n`), [KEY_A])
})

test("nothing in, nothing out", () => {
  assert.deepEqual(parseKeys(""), [])
  assert.deepEqual(parseKeys(undefined), [])
  assert.deepEqual(parseKeys(null), [])
})

test("a key is sk_ and the base64 alphabet, at its own length", () => {
  assert.ok(KEY_PATTERN.test(KEY_A))
  assert.equal(KEY_A.length, KEY_LENGTH)
  assert.ok(!KEY_PATTERN.test("sk-short"), "no sk_ prefix")
  assert.ok(!KEY_PATTERN.test("sk_" + "A".repeat(10)), "too short to be a key")
  assert.ok(!KEY_PATTERN.test(KEY_A.slice(0, -1) + "!"), "not the base64 alphabet")
})

test("keyProblem names the length when a key is short or long", () => {
  assert.equal(keyProblem(KEY_A), "")
  assert.match(keyProblem(KEY_A.slice(0, 200)), /truncated \(200 of 267/)
  assert.match(keyProblem(KEY_A + "AAAA"), /too long \(271 of 267/)
  assert.match(keyProblem("hello"), /no sk_ prefix/)
  assert.match(keyProblem(""), /no sk_ prefix/)
  assert.match(keyProblem(undefined), /no sk_ prefix/)
})

test("the same key twice in one batch is added once", () => {
  const { fresh, duplicates } = classify([KEY_A, KEY_A, KEY_B])
  assert.deepEqual(fresh, [KEY_A, KEY_B])
  assert.equal(duplicates.length, 1)
  assert.match(duplicates[0].reason, /repeated in the batch/)
})

test("a key already in the pool is a duplicate, not a second account", () => {
  const { fresh, duplicates } = classify([KEY_A, KEY_B], new Set([KEY_A]))
  assert.deepEqual(fresh, [KEY_B])
  assert.equal(duplicates.length, 1)
  assert.match(duplicates[0].reason, /already in the pool/)
})

test("a truncated key is refused rather than added", () => {
  // The failure this exists for: a copy that lost its tail. The alphabet
  // check cannot catch it — a short key is still all base64 — so the
  // length is what does.
  const truncated = KEY_A.slice(0, 200)
  const { fresh, invalid } = classify([truncated, KEY_B])
  assert.deepEqual(fresh, [KEY_B])
  assert.equal(invalid.length, 1)
  assert.match(invalid[0].reason, /truncated/)
})

test("something that is not a key at all is refused", () => {
  const { fresh, invalid } = classify(["hello", "sk-123", "", KEY_A])
  assert.deepEqual(fresh, [KEY_A])
  assert.equal(invalid.length, 3)
})

test("two keys of one account differ at the end, so a prefix is not a duplicate", () => {
  const samePrefix = KEY_A.slice(0, -4) + "ZZZZ"
  const { fresh } = classify([KEY_A, samePrefix])
  assert.equal(fresh.length, 2)
})

test("a report shows enough of a key to tell two apart, not enough to use", () => {
  const shown = mask(KEY_A)
  assert.match(shown, /^sk_AAA…AAAA$/)
  assert.ok(!shown.includes("A".repeat(20)))
  assert.equal(mask("short"), "…")
  assert.equal(mask(undefined), "…")
})
