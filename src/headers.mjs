// What a request has to look like before Lovable's gateway will read it.
//
// Two things it refuses, both measured against the live gateway:
//
//   1. Anthropic beta headers. Claude Code sends eight; the gateway accepts
//      three. The others are answered `400 unsupported beta: <name>`, and
//      `claude-code-20250219` is refused outright. magpie passes the
//      client's `anthropic-beta` through untouched, so the stripping has to
//      happen here.
//
//   2. Three body fields. `context_management` is refused with
//      `400 context_management is not supported`; `mcp_servers` and
//      `metadata` are refused for the same reason. Claude Code sends all
//      three on every turn.
//
// The stripping is conservative: an unknown beta is dropped rather than
// passed on, because the gateway refuses the whole request over one it does
// not know and a dropped beta costs a feature rather than the turn.

export const ALLOWED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "prompt-caching-2024-07-31",
  "context-1m-2025-08-07",
])

// Body fields the gateway refuses. `fallback_credit` and the model rewrite
// it comes with are handled in the request path rather than here: the beta
// is the part the gateway names.
export const DROP_BODY_KEYS = ["context_management", "mcp_servers", "metadata"]

// filterBetas keeps the ones the gateway reads and drops the rest. Returns
// null when nothing is left, which is the signal to remove the header
// rather than send it empty.
export function filterBetas(value) {
  if (!value) return null
  const kept = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => ALLOWED_BETAS.has(b))
  return kept.length ? kept.join(",") : null
}

// scrubBody removes the refused fields. A body that is not JSON is handed
// back as it came: the gateway's own error is more useful than a parse
// failure this plugin invented.
export function scrubBody(body) {
  if (typeof body !== "string" || !body) return { body, dropped: [] }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { body, dropped: [] }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body, dropped: [] }
  const dropped = DROP_BODY_KEYS.filter((k) => k in parsed)
  if (!dropped.length) return { body, dropped: [] }
  for (const k of dropped) delete parsed[k]
  return { body: JSON.stringify(parsed), dropped }
}
