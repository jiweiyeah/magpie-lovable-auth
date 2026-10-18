// What the gateway serves, and how each model is reached.
//
// Lovable publishes its catalog at GET /v1/models — no key needed, 59
// models, with everything magpie wants already in the reply:
//
//   supported_surfaces  which protocol answers this model
//   context_window      tokens, a real number
//   max_tokens          the reply's own ceiling
//   modalities.input    text / image / audio / video
//   pricing             USD per token, per tier
//
// So the catalog is read rather than kept. The list below is the fallback
// for the window before the first read lands, or for a machine the gateway
// cannot be reached from — not a catalog to maintain by hand.
//
// The one thing the gateway does not say is which `npm` reaches a surface.
// magpie picks the protocol from a model's `npm`, so that mapping lives
// here, and it is the whole reason this file exists.

export const ANTHROPIC = "@ai-sdk/anthropic"
export const OPENAI = "@ai-sdk/openai-compatible"

export const BASE = "https://ai.gateway.lovable.dev"

// SURFACE_NPM is the protocol a surface is reached on.
//
// Only chat surfaces are reachable through magpie: speech, transcription,
// embeddings, videos, image generation and System One have no OpenAI or
// Anthropic chat shape to carry them, so a model that serves only those is
// left out of the catalog rather than listed and failing.
const SURFACE_NPM = {
  messages: ANTHROPIC,
  "chat-completions": OPENAI,
  responses: OPENAI,
}

// CHAT_SURFACES is the order a model's surfaces are tried in. A model that
// serves more than one — `["chat-completions","responses"]` — is reached on
// the first one magpie can speak, which is chat-completions.
const CHAT_SURFACES = ["messages", "chat-completions", "responses"]

// FALLBACK is what the gateway served when this plugin was written. It is
// the window before the first listing lands, not a list to keep current.
export const FALLBACK = [
  { id: "anthropic/claude-fable-5-1", name: "Claude Fable 5.1", surfaces: ["messages"], context: 1000000, output: 128000 },
  { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", surfaces: ["messages"], context: 200000, output: 64000 },
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5", surfaces: ["messages"], context: 1000000, output: 128000 },
  { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", surfaces: ["messages"], context: 1000000, output: 128000 },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", surfaces: ["messages"], context: 1000000, output: 128000 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", surfaces: ["chat-completions"], context: 1000000, output: 65536 },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", surfaces: ["chat-completions"], context: 1048576, output: 65536 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", surfaces: ["chat-completions"], context: 1048576, output: 65536 },
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash Preview", surfaces: ["chat-completions"], context: 1000000, output: 65000 },
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", surfaces: ["chat-completions"], context: 1000000, output: 65000 },
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", surfaces: ["chat-completions"], context: 1000000, output: 64000 },
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", surfaces: ["chat-completions"], context: 1000000, output: 64000 },
  { id: "google/gemini-3.6-flash", name: "Gemini 3.6 Flash", surfaces: ["chat-completions"], context: 1000000, output: 64000 },
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", surfaces: ["chat-completions"], context: 1000000, output: 64000 },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", surfaces: ["chat-completions"], context: 1048576, output: 65536 },
  { id: "google/gemini-4-argon", name: "Gemini 4 Argon", surfaces: ["chat-completions"], context: 1048576, output: 1048576 },
  { id: "openai/chat-latest", name: "Chat (latest)", surfaces: ["chat-completions", "responses"], context: 128000, output: 16384 },
  { id: "openai/gpt-5", name: "GPT-5", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5-mini", name: "GPT-5 mini", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5-nano", name: "GPT-5 nano", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5.2", name: "GPT-5.2", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5.4", name: "GPT-5.4", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 mini", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5.4-nano", name: "GPT-5.4 nano", surfaces: ["chat-completions", "responses"], context: 400000, output: 128000 },
  { id: "openai/gpt-5.4-pro", name: "GPT-5.4 pro", surfaces: ["responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-5.5", name: "GPT-5.5", surfaces: ["chat-completions", "responses"], context: 1000000, output: 128000 },
  { id: "openai/gpt-5.5-pro", name: "GPT-5.5 pro", surfaces: ["responses"], context: 1000000, output: 128000 },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-6-astra", name: "GPT-6 Astra", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-6-luna", name: "GPT-6 Luna", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-6-sol", name: "GPT-6 Sol", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", surfaces: ["chat-completions", "responses"], context: 1050000, output: 128000 },
]

// npmOf is the protocol a model's surfaces are reached on, or "" when it
// serves no surface magpie can carry.
export function npmOf(surfaces) {
  for (const s of CHAT_SURFACES) if (surfaces?.includes(s)) return SURFACE_NPM[s]
  return ""
}

// tierCost is a pricing tier list's first price, in USD per token.
//
// The list is tiered by volume; the first tier starts at 0, which is what
// a request costs before any discount. A list that names no price carries
// 0 rather than a guess, and magpie shows no cost for it.
function tierCost(list) {
  const first = Array.isArray(list?.tiers) ? list.tiers[0] : undefined
  const n = Number(first?.cost)
  return Number.isFinite(n) ? n : 0
}

// priceOf maps the gateway's pricing onto magpie's cost shape.
//
// magpie's `cost` is USD per token: input, output, and the two cache
// directions. The gateway names them `input.text`, `output.text`,
// `input.text.cache_read` and `input.text.cache_write`.
function priceOf(pricing) {
  return {
    input: tierCost(pricing?.input?.text),
    output: tierCost(pricing?.output?.text),
    cache: {
      read: tierCost(pricing?.input?.text?.cache_read),
      write: tierCost(pricing?.input?.text?.cache_write),
    },
  }
}

// parseListing turns the gateway's reply into catalog entries.
//
// A model that serves no chat surface is left out: listing it would offer
// an agent a model that answers on a path magpie cannot send to.
export function parseListing(reply) {
  const data = Array.isArray(reply?.data) ? reply.data : []
  const out = []
  for (const m of data) {
    if (!m || typeof m.id !== "string") continue
    if (m.deprecated === true) continue
    const surfaces = Array.isArray(m.supported_surfaces) ? m.supported_surfaces : []
    const npm = npmOf(surfaces)
    if (!npm) continue
    const input = Array.isArray(m.modalities?.input) ? m.modalities.input : ["text"]
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      npm,
      context: Number.isFinite(m.context_window) ? m.context_window : 0,
      output: Number.isFinite(m.max_tokens) ? m.max_tokens : 0,
      images: input.includes("image"),
      reasoning: m.reasoning === true || m.owned_by === "anthropic" && surfaces.includes("messages"),
      cost: priceOf(m.pricing),
    })
  }
  return out
}

// normalizeFallback gives the hand-kept list the same shape a listing has,
// so nothing downstream has to know which one it got.
export function normalizeFallback() {
  return FALLBACK.map((m) => ({
    ...m,
    npm: npmOf(m.surfaces),
    images: true,
    reasoning: m.surfaces.includes("messages"),
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  })).filter((m) => m.npm)
}

// configModel is one entry in the shape magpie's config hook wants.
//
// `provider.npm` and `provider.api` here are what make one provider speak
// two protocols: magpie reads a model's protocol from its own entry
// (`host: m.provider?.npm ?? cfg.npm ?? …`), so the protocol is a property
// of the model rather than of the provider.
export function configModel(m) {
  return {
    name: m.name,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    ...(m.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
    ...(m.reasoning ? { reasoning: true } : {}),
    tool_call: true,
    provider: { npm: m.npm, api: BASE },
  }
}

// runtimeModel is one entry in the shape `provider.models` returns.
//
// That hook REPLACES what magpie built from config rather than merging into
// it, so every field magpie draws from has to be carried here or it is
// lost — `limit.context` is the one that shows as the context badge.
export function runtimeModel(m) {
  return {
    id: m.id,
    providerID: "lovable",
    name: m.name,
    api: { id: m.id, url: BASE, npm: m.npm },
    status: "active",
    headers: {},
    options: {},
    cost: m.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      toolcall: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  }
}
