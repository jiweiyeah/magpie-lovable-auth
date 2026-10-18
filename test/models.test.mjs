import test from "node:test"
import assert from "node:assert/strict"

import {
  parseListing,
  normalizeFallback,
  npmOf,
  configModel,
  runtimeModel,
  ANTHROPIC,
  OPENAI,
} from "../src/models.mjs"

// A slice of the gateway's own reply, kept as it came.
const LISTING = {
  object: "list",
  data: [
    {
      id: "anthropic/claude-sonnet-5",
      object: "model",
      deprecated: false,
      name: "Claude Sonnet 5",
      context_window: 1000000,
      max_tokens: 128000,
      modalities: { input: ["text", "image"], output: ["text", "search"] },
      supported_surfaces: ["messages"],
      pricing: {
        input: {
          text: {
            tiers: [{ cost: "0.000002", min: 0 }],
            cache_read: { tiers: [{ cost: "0.0000002", min: 0 }] },
            cache_write: { tiers: [{ cost: "0.0000025", min: 0 }] },
          },
        },
        output: { text: { tiers: [{ cost: "0.00001", min: 0 }] } },
      },
    },
    {
      id: "openai/gpt-5.5",
      object: "model",
      deprecated: false,
      name: "GPT-5.5",
      context_window: 1000000,
      max_tokens: 128000,
      modalities: { input: ["text", "image"] },
      supported_surfaces: ["chat-completions", "responses"],
      pricing: { input: { text: { tiers: [{ cost: "0.000001" }] } }, output: { text: { tiers: [{ cost: "0.000004" }] } } },
    },
    {
      id: "openai/gpt-5.4-pro",
      object: "model",
      deprecated: false,
      name: "GPT-5.4 pro",
      context_window: 1050000,
      max_tokens: 128000,
      modalities: { input: ["text", "image"] },
      supported_surfaces: ["responses"],
    },
    {
      id: "google/veo-3.1",
      object: "model",
      deprecated: false,
      name: "Veo 3.1",
      context_window: 0,
      max_tokens: 0,
      modalities: { input: ["text", "image"] },
      supported_surfaces: ["videos"],
    },
    {
      id: "openai/text-embedding-3-small",
      object: "model",
      deprecated: false,
      name: "Text Embedding 3 Small",
      supported_surfaces: ["embeddings"],
    },
    {
      id: "anthropic/claude-old",
      object: "model",
      deprecated: true,
      name: "Claude Old",
      supported_surfaces: ["messages"],
    },
  ],
}

test("a model is reached on the first surface magpie can carry", () => {
  assert.equal(npmOf(["messages"]), ANTHROPIC)
  assert.equal(npmOf(["chat-completions", "responses"]), OPENAI)
  assert.equal(npmOf(["responses"]), OPENAI)
  assert.equal(npmOf(["videos"]), "", "no chat surface, no protocol")
  assert.equal(npmOf(undefined), "")
})

test("the catalog keeps every model, marking the ones magpie cannot reach", () => {
  const models = parseListing(LISTING)
  const ids = models.map((m) => m.id)
  assert.deepEqual(ids, [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.5",
    "openai/gpt-5.4-pro",
    "google/veo-3.1",
    "openai/text-embedding-3-small",
  ])
  assert.ok(!ids.includes("anthropic/claude-old"), "a deprecated model is left out")

  // a reachable model carries no mark
  assert.equal(models.find((m) => m.id === "anthropic/claude-sonnet-5").unsupported, "")

  // an unreachable one names its surface instead of disappearing
  assert.equal(models.find((m) => m.id === "google/veo-3.1").unsupported, "video")
  assert.equal(models.find((m) => m.id === "openai/text-embedding-3-small").unsupported, "embeddings")
})

test("an unreachable model is listed and marked in its name, not hidden", () => {
  const veo = parseListing(LISTING).find((m) => m.id === "google/veo-3.1")
  const r = runtimeModel(veo)
  // `deprecated` is filtered out of the provider list by the host, so
  // marking one that way would hide it rather than label it.
  assert.equal(r.status, "active")
  assert.match(r.name, /video only/, "the name is the mark that survives")
  assert.equal(r.capabilities.toolcall, false, "and no tool calling, so nothing picks it for work")
  assert.match(configModel(veo).name, /video only/)
})

test("the protocol is carried per model, not per provider", () => {
  const models = parseListing(LISTING)
  const claude = models.find((m) => m.id === "anthropic/claude-sonnet-5")
  const gpt = models.find((m) => m.id === "openai/gpt-5.5")
  assert.equal(claude.npm, ANTHROPIC)
  assert.equal(gpt.npm, OPENAI)
  assert.equal(configModel(claude).provider.npm, ANTHROPIC)
  assert.equal(configModel(gpt).provider.npm, OPENAI)
  assert.equal(runtimeModel(claude).api.npm, ANTHROPIC)
  assert.equal(runtimeModel(gpt).api.npm, OPENAI)
})

test("context and output come from the gateway, not from a guess", () => {
  const [claude] = parseListing(LISTING)
  assert.equal(claude.context, 1000000)
  assert.equal(claude.output, 128000)
  assert.equal(runtimeModel(claude).limit.context, 1000000)
})

test("pricing is USD per token in magpie's cost shape", () => {
  const [claude] = parseListing(LISTING)
  assert.equal(claude.cost.input, 0.000002)
  assert.equal(claude.cost.output, 0.00001)
  assert.equal(claude.cost.cache.read, 0.0000002)
  assert.equal(claude.cost.cache.write, 0.0000025)
})

test("a model with no price carries no cost rather than a guess", () => {
  const gptPro = parseListing(LISTING).find((m) => m.id === "openai/gpt-5.4-pro")
  assert.deepEqual(gptPro.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } })
})

test("a reply that is not a listing yields nothing rather than throwing", () => {
  assert.deepEqual(parseListing(undefined), [])
  assert.deepEqual(parseListing({}), [])
  assert.deepEqual(parseListing({ data: "nope" }), [])
  assert.deepEqual(parseListing({ data: [null, 1, { id: 5 }] }), [])
})

test("the fallback has the same shape a listing does", () => {
  const models = normalizeFallback()
  assert.ok(models.length > 30)
  for (const m of models) {
    assert.ok(m.id)
    assert.ok(m.npm === ANTHROPIC || m.npm === OPENAI, `${m.id} has a protocol`)
    assert.ok(m.cost && typeof m.cost.input === "number")
  }
  const claude = models.find((m) => m.id === "anthropic/claude-sonnet-5")
  assert.equal(claude.npm, ANTHROPIC)
})

test("runtimeModel carries the fields magpie draws from", () => {
  const [claude] = parseListing(LISTING)
  const r = runtimeModel(claude)
  // the hook replaces what magpie built, so these are not optional
  assert.equal(r.limit.context, 1000000)
  assert.equal(r.api.url, "https://ai.gateway.lovable.dev")
  assert.equal(r.capabilities.input.image, true)
  assert.equal(r.capabilities.toolcall, true)
  assert.equal(r.providerID, "lovable")
})
