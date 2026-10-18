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
generation. They are listed too, with their surface in the name:

```
lovable/google/gemini-2.5-flash-tts  Gemini 2.5 Flash TTS — text-to-speech only
lovable/google/veo-3.1               Veo 3.1 — video only
```

Dropping them made the account look smaller than it is; listing them as
ordinary models would offer an agent one that cannot answer. So they keep
their place and lose their tool calling — which is what an agent picks a
model for — and their name says why.

**They are not marked `deprecated`.** The host filters deprecated models out
of the provider list entirely, so marking one hides it rather than labelling
it — the opposite of the intent.

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

`auth.usage` reports the book, so the account row and `magpie quota lovable`
show what this plugin actually read:

```
lovable · 9/13 ok · 4 failed · last ok 00:17 · API key …Gw==
```

That row is the book, not an allowance. There is no allowance to read, and
`windows` stays empty on purpose — a window without a `resetsAt` never lifts
once it fills, so inventing one would park a working account.

The last success goes in the plan line, **not** in `until`: magpie reads
`until` as the plan's renewal date and renders "renews <day>", which is a
claim about the account nothing read.

The account's own name is magpie's doing — an API key has no account id, so
the host names it `API key …` plus the key's last four characters
(`host:951`).

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

Past a few dozen keys, use the pool instead — see
[A pool larger than the account list](#a-pool-larger-than-the-account-list).

**A key's allowance is the account's, not the key's.** Two keys minted from
one Lovable account share one credit balance and one rate bucket — a second
key from the same account adds no capacity. A pool only grows by adding
*accounts*.

### A batch at once

`magpie plugin login` is one prompt per key. For a file:

```bash
node bin/import-keys.mjs keys.txt          # one key per line
node bin/import-keys.mjs sk_a…,sk_b…       # or a comma list
cat keys.txt | node bin/import-keys.mjs -  # or stdin
node bin/import-keys.mjs keys.txt --dry-run  # say what it would do
```

Two mistakes a batch makes silently, both caught:

**The same key twice.** magpie would make it two accounts, so a turn routed
to the second is a turn spent on a key already in the pool. Compared on the
whole key — two keys of one account share a prefix and differ at the end —
and against every key already in `plugin-auth.json`, not just this
provider's.

**A truncated key.** A copy that lost its tail is still all base64, so an
alphabet check passes it and the key authenticates as nothing: 401 on every
turn it is given. Lovable's keys are 267 characters, and the length is what
catches it.

```
add    sk_J088…Gw==  as lovable#1ui6pc
skip   sk_AAA…AAAA  already in the pool
refuse sk_ABC…sW/z  truncated (200 of 267 characters)
refuse …            not a key (no sk_ prefix)

1 added · 1 duplicate · 2 invalid
```

It writes under the host's own lock and through the same durable write, so a
magpie that is running when this runs does not write its own newer changes
away with what it read before. A report shows `sk_J088…Gw==`: enough to tell
two keys apart, not enough to use one.

Reopen magpie afterwards so the new accounts are read.

## A pool larger than the account list

One key per account stops working somewhere in the hundreds, and it is not
magpie's limit — it is the shape of the account list:

| accounts | `magpie accounts` | a gateway request |
|---|---|---|
| 21 | instant | 2 s |
| 71 | fine | fine |
| 271 | slow | `too many plugin calls are in flight` |
| 1771 | 16 s | **no answer at all** (60 s timeout) |

Every account is a row, and the host calls the plugin once per row to draw
it. A thousand rows is a thousand loader calls before the page lands. There
is no hard cap; there is a cliff.

So keys are kept in a **pool** and magpie is given **slots**. A slot is an
account with no key of its own:

```json
{ "type": "api", "key": "", "pool": true }
```

The loader answers a slot with a `fetch` that takes one key from the pool
per request — round-robin, skipping keys that are resting or retired — and
writes the real `authorization` header itself. magpie sees `slots` rows
however many keys the pool holds; the UI stays eight rows for seventeen
hundred keys.

```bash
node bin/pool.mjs load keys.txt              # one key per line
node bin/pool.mjs load lovable_accounts.jsonl --ledger   # or a JSONL ledger
node bin/pool.mjs load keys.txt --dry-run    # say what it would add
node bin/pool.mjs status                     # keys, live, resting, retired
node bin/pool.mjs slots 8                    # eight slots, the rest of the keys behind them
node bin/pool.mjs slots 0                    # remove every slot
```

The importer is incremental by construction: it compares against what the
pool already holds, so running it against a growing ledger adds only the new
keys. `--ledger` skips records marked `success: false`, `key_dead: true`, or
carrying no `api_key`.

Two things a slot changes about failure:

**A 402 retires the key, not the slot.** One dead key behind a slot must not
take the whole pool out of rotation, so the slot answers 502 and the next
request takes another key. Only the single-key path hands magpie
`signIn: "expired"`.

**An empty pool answers without reaching the vendor.** "No key can be
tried: 1714 keys, 1714 out of credits" costs nothing and is the truth;
spending a request to be told 402 again is not.

A 429 rests the key for a minute; three consecutive 5xx/network failures
rest it for thirty seconds. Both are in memory — a restart forgets the
rests, which is fine (they are short) and deliberate: the retirements are
the ones that must survive, and they are in the book beside the key file
(`.lovable-pool.txt.book.json`), never in it.

The pool file and its book hold real keys and are gitignored.

## Files

```
src/index.mjs     the plugin: loader, fetch, usage, config, models
src/headers.mjs   the beta filter and the body scrub
src/models.mjs    the catalog: reading it, and the fallback
src/keys.mjs      the book: what each key has done, and what that means
src/import.mjs    a batch of keys: parsing, dedupe, the length check
src/pool.mjs      the pool: round-robin, rests, retirements
bin/import-keys.mjs  the batch importer, under the host's own lock
bin/pool.mjs      load keys, make slots
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
