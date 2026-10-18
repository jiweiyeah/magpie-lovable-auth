# magpie-lovable-auth

Lovable's AI Gateway ([ai.gateway.lovable.dev](https://ai.gateway.lovable.dev))
as a magpie provider — with the beta stripping Claude Code needs, a key pool,
and a per-key book of what each key has done.

```bash
magpie plugin add /path/to/magpie-lovable-auth
magpie plugin login lovable          # paste a key, or add several
magpie provider test lovable
```

## Why this exists

magpie's own custom provider reaches Lovable fine from an OpenAI-shaped
client, and fails every Claude Code turn. Two refusals, both the gateway's:

**Anthropic beta headers.** Claude Code sends eight; the gateway reads three
and refuses the request over any of the others — `claude-code-20250219` is
refused outright. magpie passes `anthropic-beta` through untouched, so the
stripping has to happen inside a provider plugin's `fetch`.

**Three body fields.** `context_management` is answered
`400 context_management is not supported`; `mcp_servers` and `metadata` the
same. Claude Code sends all three on every turn.

Both are handled in `src/headers.mjs`. The stripping is conservative: an
unknown beta is dropped rather than passed on, because one the gateway does
not know fails the whole request while a dropped one costs a feature.

## Two protocols, one provider

The gateway answers Anthropic Messages at `/v1/messages` for the Claude
models and OpenAI chat at `/v1/chat/completions` for everything else. A
provider-level `npm` would send every model down one path and half of them
would answer `model is not supported on /v1/messages`.

magpie reads a model's protocol from the model's own entry
(`m.provider?.npm ?? cfg.npm ?? …`), so the protocol is declared per model:

```js
{ id: "anthropic/claude-sonnet-5", provider: { npm: "@ai-sdk/anthropic", api: BASE } }
{ id: "openai/gpt-5.5",            provider: { npm: "@ai-sdk/openai-compatible", api: BASE } }
```

## The catalog is read, not kept

`GET /v1/models` answers without a key: 59 models, with `supported_surfaces`,
`context_window`, `max_tokens`, `modalities` and `pricing` already in the
reply. So the catalog is read and cached for ten minutes, and
`src/models.mjs`'s fallback list is only the window before the first read
lands.

`supported_surfaces` is what makes this work: it names the protocol. 23 of
the 59 serve a chat surface — `messages`, `chat-completions` or `responses`.
The other 36 are speech, transcription, embeddings, videos and image
generation, and are left out rather than listed and failing.

`pricing` is USD per token, per tier; the first tier is what a request costs,
and it maps straight onto magpie's `cost`.

## A key that runs out is taken out

Lovable publishes **no allowance endpoint**. `/v1/credits`, `/v1/usage`,
`/v1/me`, `/v1/balance`, `/v1/limits` and `/v1/quota` all answer 404, and no
reply carries a `ratelimit-*` header. So the only reading of a key's health
is what this plugin saw itself, and it keeps that in `.lovable-book.json`
beside the plugin.

Two statuses matter, and they mean different things:

| | 429 | 402 |
|---|---|---|
| body | `rate_limited` | `payment_required` / "Not enough credits" |
| whose | the key's rate | the **account's** — two keys of one account both get it |
| lifts? | in about a minute | never (measured 50+ minutes, `retryable: false`) |

A 429 is counted and the key stays. A 402 retires the account for good: the
key is booked as gone, every later request is answered without reaching the
vendor, and the error carries `signIn: "expired"` — the field magpie reads to
take an account out of rotation (`host:2373`). Without it the refusal reaches
magpie as text naming no status, magpie answers 502, 502 is *temporary*, and
the account stays in rotation failing every turn handed to it.

The book names a key by a short hash, never by the key: a book that writes
the key is a book that leaks it.

## What each key has done

`auth.usage` reports the book, so `magpie quota lovable` and the app's
account row show real numbers instead of a "not configured" placeholder:

```
lovable · 42/45 ok · 3 rate-limited
  key 3f2a91c4
```

A retired key says so in words, because magpie renders every lapsed sign-in
as "sign in again" and for an account with no credits that is the one
instruction that cannot work:

```
lovable · retired · out of credits
  key 3f2a91c4
  key 3f2a91c4 answered 402 payment_required and Lovable does not lift it
  — this account has no credits left
```

## Adding keys

Each key is one magpie account, so a pool is several keys under one provider:

```bash
magpie plugin login lovable     # first key
magpie plugin login lovable     # and each one after it
magpie quota lovable            # every account, one row each
```

magpie names them `lovable`, `lovable#abc123`, … and rotates between them.
A 402 retires one account without touching the others.

**A key's allowance is the account's, not the key's.** Two keys minted from
one Lovable account share one credit balance and one rate bucket — a second
key from the same account adds no capacity. A pool only grows by adding
*accounts*.

## Files

```
src/index.mjs     the plugin: loader, fetch, usage, config, models
src/headers.mjs   the beta filter and the body scrub
src/models.mjs    the catalog: reading it, and the fallback
src/keys.mjs      the book: what each key has done, and what that means
test/             the edges against fixtures, and the gateway itself
```

## Testing

```bash
npm test                          # the edges, against fixtures
LOVABLE_KEY=sk_... npm test       # and against the live gateway
```

The live tests send a real Claude Code-shaped turn — eight betas, three
refused body fields, magpie's placeholder authorization — and assert the
gateway answers it. Run those after a gateway change; they are what proves
the stripping list is still the right one.

## License

MIT
