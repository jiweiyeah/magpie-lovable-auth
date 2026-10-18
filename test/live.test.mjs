// Against the live gateway. Skipped unless LOVABLE_KEY is set:
//
//   LOVABLE_KEY=sk_... npm test
//
// The unit tests prove the logic; this one proves the gateway still wants
// what the logic sends it. Run it after a gateway change, not on every edit.

import test from "node:test"
import assert from "node:assert/strict"

import LovableAuth from "../src/index.mjs"
import { BASE, parseListing } from "../src/models.mjs"

const KEY = process.env.LOVABLE_KEY
const skip = KEY ? false : "set LOVABLE_KEY to run against the live gateway"

test("the gateway's catalog is what this plugin reads it as", { skip }, async () => {
  const res = await fetch(`${BASE}/v1/models`)
  assert.equal(res.status, 200)
  const models = parseListing(await res.json())
  // The gateway lists 59; the rest are speech, transcription, embeddings,
  // videos and image generation — surfaces magpie has no chat shape for.
  assert.ok(models.length >= 20, `expected a chat catalog, got ${models.length}`)
  const claude = models.find((m) => m.id === "anthropic/claude-sonnet-5")
  assert.ok(claude, "sonnet-5 is in the catalog")
  assert.equal(claude.npm, "@ai-sdk/anthropic")
  assert.ok(claude.context >= 200000)
})

test("a stripped Claude Code turn is answered", { skip }, async () => {
  const plugin = await LovableAuth({}, {})
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: KEY }))

  // What Claude Code sends: eight betas, three body fields the gateway
  // refuses, and a model the gateway serves.
  const res = await loader.fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-2024-07-31,context-1m-2025-08-07,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,context_management,fallback-credit-2026-06-01",
      // magpie's placeholder, which the fetch must replace
      authorization: "Bearer lovable",
    }),
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      context_management: { edits: [] },
      mcp_servers: [],
      metadata: { user_id: "test" },
    }),
  })

  const text = await res.text()
  assert.equal(res.status, 200, `gateway answered ${res.status}: ${text.slice(0, 400)}`)
  const body = JSON.parse(text)
  assert.ok(Array.isArray(body.content), "an Anthropic Messages reply")
  assert.equal(body.type, "message")
})

test("the catalog's protocol per model is the one the gateway answers on", { skip }, async () => {
  const plugin = await LovableAuth({}, {})
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: KEY }))

  // A chat-completions model on the chat path
  const res = await loader.fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  })
  const text = await res.text()
  assert.equal(res.status, 200, `gateway answered ${res.status}: ${text.slice(0, 400)}`)
  const body = JSON.parse(text)
  assert.ok(Array.isArray(body.choices), "an OpenAI chat reply")
})
