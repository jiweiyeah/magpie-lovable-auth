import test from "node:test"
import assert from "node:assert/strict"

import { filterBetas, scrubBody, ALLOWED_BETAS, DROP_BODY_KEYS } from "../src/headers.mjs"

test("keeps the three betas the gateway reads", () => {
  const sent = [
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-2024-07-31",
    "context-1m-2025-08-07",
    "oauth-2025-04-20",
    "fine-grained-tool-streaming-2025-05-14",
    "context_management",
    "fallback-credit-2026-06-01",
  ].join(",")
  assert.equal(
    filterBetas(sent),
    "interleaved-thinking-2025-05-14,prompt-caching-2024-07-31,context-1m-2025-08-07",
  )
})

test("a header with nothing left is removed, not sent empty", () => {
  assert.equal(filterBetas("claude-code-20250219,oauth-2025-04-20"), null)
  assert.equal(filterBetas(""), null)
  assert.equal(filterBetas(undefined), null)
  assert.equal(filterBetas(null), null)
})

test("whitespace around a beta does not hide it", () => {
  assert.equal(filterBetas("  prompt-caching-2024-07-31  ,  "), "prompt-caching-2024-07-31")
})

test("the allowed set is exactly the three the gateway reads", () => {
  assert.deepEqual([...ALLOWED_BETAS].sort(), [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-2024-07-31",
  ])
})

test("drops the three body fields the gateway refuses", () => {
  const body = JSON.stringify({
    model: "anthropic/claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    context_management: { edits: [] },
    mcp_servers: [],
    metadata: { user_id: "x" },
    max_tokens: 100,
  })
  const out = scrubBody(body)
  const parsed = JSON.parse(out.body)
  assert.deepEqual(out.dropped.sort(), [...DROP_BODY_KEYS].sort())
  assert.equal(parsed.context_management, undefined)
  assert.equal(parsed.mcp_servers, undefined)
  assert.equal(parsed.metadata, undefined)
  // everything else survives untouched
  assert.equal(parsed.model, "anthropic/claude-sonnet-5")
  assert.equal(parsed.max_tokens, 100)
  assert.deepEqual(parsed.messages, [{ role: "user", content: "hi" }])
})

test("a body with none of them is handed back byte for byte", () => {
  const body = '{"model":"x","messages":[]}'
  const out = scrubBody(body)
  assert.equal(out.body, body)
  assert.deepEqual(out.dropped, [])
})

test("a body that is not JSON is not rewritten", () => {
  const body = "not json at all"
  assert.deepEqual(scrubBody(body), { body, dropped: [] })
})

test("a non-string body is passed through", () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.deepEqual(scrubBody(bytes), { body: bytes, dropped: [] })
  assert.deepEqual(scrubBody(undefined), { body: undefined, dropped: [] })
})

test("an array body is left alone", () => {
  const body = "[1,2,3]"
  assert.deepEqual(scrubBody(body), { body, dropped: [] })
})
