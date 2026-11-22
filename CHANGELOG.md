# Changelog

## Unreleased

### Performance

- **The pool no longer parses and rewrites `pool.json` on every request.**
  `beginTask` and `endTask` each did one `loadPool()` + one `savePool()`, i.e.
  two full parses and two full rewrites of a ~100 KB file per request (24
  writes / ~2.3 MB per 12-request wave). Reads now go through an in-memory copy
  that is re-parsed only when the disk signature (ino + mtime + size) changes,
  and writes are split in two: configuration and cooldown changes still hit
  disk synchronously, while statistics (`lastUsedAt`, req/token/ms, series
  samples, the round-robin cursor) are coalesced — flushed 500 ms after traffic
  goes quiet, and at most once every 2 s under sustained load. Measured with
  `.wbperf/bench-pool-writes.mjs`: one 12-request wave drops from 24 writes /
  2.34 MB to 1 write / 96 KB, `beginTask` from 1.04 ms to 0.01 ms and
  `endTask` from 1.11 ms to 0.02 ms.
  Coalesced statistics are flushed on `exit` and on `SIGINT`/`SIGTERM`/`SIGHUP`;
  the signal hooks only call `process.exit(0)` when no other handler is
  registered, so Ctrl+C keeps working for embedders.
  When another process rewrites the file (`wb pool`, a second bridge), the
  merge rule is configuration-from-disk and statistics-from-memory: a slot
  change takes effect on the next request without discarding accounting that
  has not been flushed yet.

### Added

- **Per-account concurrency is configurable from the CLI and the dashboard.**
  `maxConcurrency` already existed in the schema and in the PATCH route, but
  there was no way to set it without hand-editing `pool.json`, and nothing to
  observe it with. `wb pool concurrency <name> <1-10>`, a "并发 N" button on
  each account card, and `defaultMaxConcurrency` for newly discovered accounts.
  The value is clamped to 1–10 on write; the default is still 1. Upstream allows
  same-account concurrency (measured 1/2/4/6/8 with no 429 and no
  serialization), but 3 is the recommended ceiling: a 429 here can cost hours
  of cooldown.
- **`today.peakInflight` and `today.rateLimited` are recorded per account** and
  shown on the card under the concurrency KPI. Opening up concurrency without
  these two numbers leaves no basis for rolling back.
- **`Retry-After` is honoured and surfaced.** A 429 carrying `Retry-After`,
  `retry-after-ms`, `x-ratelimit-reset` or a reset timestamp in the body now
  produces a cooldown that ends at that moment instead of an exponential guess
  (1 → 2 → 4 … min, 30 min cap, still the fallback). The same deadline goes
  back to the client as `Retry-After` in the error response.

### Fixed

- **A model whose catalogue entry simply omits `reasoning` no longer loses the
  client's `reasoning_effort`.** `reasoningDeclaration` collapsed "the upstream
  says this model cannot reason" and "the upstream said nothing about reasoning"
  into the same `form: "none"`, and the resolver deleted the effort for both.
  Nine of the 36 models in the live catalogue (`default`, `glm-4.6`, `glm-5.0`,
  `glm-4.7`, `hunyuan-*`…) fall in the second bucket and accept any effort
  upstream (verified: `null`/`high`/`none`/`xhigh`/`max` all return 200). The
  declaration now carries `known`; only `known: true && form: "none"` drops the
  field, and missing metadata passes the client's value through. `wb_reasoning`
  in `/v1/models` publishes the new `known` flag.
- **Chat and Responses re-resolve the effort after a 401 re-auth.** Only the
  Anthropic runtime re-read the catalogue after switching accounts, so the other
  two paths kept sending the old account's effort. All three now share
  `applyEffortToBody`.
- **A reasoning-history experiment was reverted: it leaked the model's thinking
  into visible output.** `5157f0b` folded Anthropic `thinking` blocks and
  Responses `reasoning` items into assistant messages tagged
  `<prior_reasoning>…</prior_reasoning>`, so the model would not forget what it
  had worked out. The upstream has only a content channel, so that wrapper read
  to the model as "something I said last turn" — it adopted the format and wrote
  its reasoning into visible text, which codex then rendered to the user. Both
  injection paths are gone again: `thinking` / `redacted_thinking` blocks and
  replayed `reasoning` items are dropped. Persisted `reasoning.summary` is still
  preserved for `GET /v1/responses/:id`, but that path never enters upstream
  messages. Losing prior thinking is cheaper than leaking it.
- **The 256 KiB persistence budget is allocated per item instead of sequentially.**
  A 300 KB `apply_patch` used to consume the whole budget, leaving the following
  `function_call.arguments` and assistant message as empty strings — and
  `arguments: ""` is not valid JSON. Every text slot now gets
  `min(bytes, 4 KiB)` first and only the remainder is handed out in order.
  Truncation writes `…[bridge-truncated: N bytes]`, and a truncated
  `function_call.arguments` becomes valid JSON
  `{"_bridge_truncated":true,"bytes":N,"preview":"…"}`.
- **A 429 on a single-account pool no longer triggers a pointless retry.**
  `RETRY_STATUS` includes 429, so the retry loop picked another account — with
  a single account that meant re-selecting the same one and hitting the rate
  limit again. The loop now stops when no other account can serve the request,
  and the 429 passes straight through to the client.

### Changed

- **The continuation nudge applies to coding agents and tool loops, not to every
  request that declares tools.** `continuationNudge: true` now means `auto`:
  inject only when the request is recognised as a coding agent (`originator:
  codex_*`, `x-codex-*` headers, `client_metadata` carrying `x-codex-*`, or
  `user-agent: pi (…)`) or when the history already contains a tool round trip.
  `WB_CONTINUATION_NUDGE=1` forces `always`, `0` forces `off`. Plain Q&A and
  unrelated clients are no longer polluted.
- **Rule 2 of the nudge text no longer bans narration.** It used to forbid
  describing what the model was doing, which made the whole turn opaque: with the
  loop fixed you could no longer tell what the model was working on or why.
  Verified that codex does not treat "explanation + tool call in one turn" as
  completion (2 upstream requests, text shown), so the rule now permits one or
  two sentences of progress explanation and only forbids describing a plan
  without acting on it. Rule 4 no longer overrides the client's approval policy,
  and rule 5 gives repeated patch failures a termination condition.
- **The nudge stays after the last user message.** Moving it to the end of the
  list put a `system` message directly after a tool result, which codex read as
  the start of a new instruction and answered instead of continuing the tool
  loop — the "stops right after a tool call or a progress note" regression.
  `tool_choice: "none"` still suppresses it.
- **Coding-agent detection is deliberately loose.** `auto` mode matched only
  `originator: codex_*` and `user-agent: pi (…)`, so a codex front end that sends
  neither header, on a first turn that has no tool history yet, got no nudge at
  all and fell back to the old "say one sentence and stop" behaviour. Detection
  now also accepts any `user-agent` containing `codex`, the `x-codex-*` headers,
  and — because `/v1/responses` is effectively coding-agent-only — injects for
  Responses requests carrying tools regardless of headers.
- The dashboard gained a "回合续跑约束" switch; the setting previously had no UI at
  all and could only be changed through `PATCH /api/api-compat` or the
  environment.

### Security

- **The admin API is no longer open by default on a non-loopback bind.**
  `adminAllowed` used to return `true` whenever `WB_ADMIN_TOKEN` was unset, so
  `wb http --host 0.0.0.0` exposed `GET/PATCH /api/api-compat` and
  `POST /api/api-compat/keys` to everyone on the same network segment: an
  anonymous peer could disable remote API-key enforcement or mint a usable key.
  The gate is now decided by the bind address — loopback keeps the local
  no-token workflow, and a non-loopback bind without a token refuses to start
  (`ADMIN_TOKEN_REQUIRED`) from both `startHttpServer` and the `wb http` /
  `wb admin` commands instead of printing an advisory. Token comparison is
  length-checked and constant-time.
- **Admin tokens are no longer accepted from the query string on API routes.**
  `?token=` reaches browser history, screenshots and reverse-proxy logs. Only the
  admin page itself accepts it as a first-visit bootstrap and immediately strips
  it with `history.replaceState`; every API request must carry `x-wb-token`.
- **`upstreamBaseUrl` can no longer point at the local host or a private
  network.** That setting decides where `authorization: Bearer <accessToken>`
  goes, so validating only `http`/`https` let a caller redirect the account token
  to their own server. Loopback, RFC1918, CGNAT, link-local (including
  169.254.169.254) and IPv6 ULA/link-local targets are rejected;
  `WB_ALLOW_PRIVATE_UPSTREAM=1` opts a deployment back in, and
  `WB_UPSTREAM_ALLOW_HOSTS=gw.example.com,*.corp.example` pins an allowlist.
- **`upstreamBaseUrl` and `timeoutMs` are actually hot.** The client used to
  capture both at construction, so a saved PATCH reported success and the
  dashboard showed the new value while requests kept going to the old endpoint.
  Both are now read from config per request; an explicitly passed `baseUrl` /
  `timeoutMs` still pins a fixture.

### Fixed

- Responses requests no longer fail with `tools[N] type web_search is not
  supported` when the client always declares upstream-hosted tools. Codex
  (`web_search = "live" | "cached"`) and DeepSeek Harness (`web_fetch`) both send
  such declarations. Hosted tool declarations (`web_search*`, `web_fetch`,
  `computer_use*`, `file_search`, `code_interpreter`, `image_generation`, `mcp`,
  `container`) are dropped instead of rejected, and a `tool_choice` naming one of
  them degrades to `auto` instead of failing the turn.
- `wb install --client dsh` resolves `DSH_HOME` when it runs instead of when the
  module loads, so an inherited `DSH_HOME` no longer redirects the write into the
  live profile (the isolated install tests failed with a read-only `EROFS`).
- Cache hits reported by the upstream now reach the account ledger as well: the
  lease result carries `cache_read_input_tokens` / `cache_creation_input_tokens`
  on Anthropic, Chat and Responses, so `pool.json` and the admin dashboard stop
  reporting a permanent 0% hit rate.
- The dashboard now reports decoding speed separately from end-to-end throughput,
  and adds a first-token latency figure. `decodeMs` runs from the first visible
  increment to the end, matching the DeepSeek Harness `decodeTokens / decodeMs`
  definition, while the old figure divides output tokens by the whole request
  wall time (queueing, first byte and a slow client included).
- Anthropic streaming responses report the real `input_tokens` in `message_delta`
  instead of leaving the client on the `message_start` estimate, which was up to
  3.7x too large for a long history and made context-occupancy readouts wrong.
- The dashboard hit rate is clamped to 100%: a source that reports a cached count
  larger than its own input (native Anthropic semantics) can no longer push the
  percentage above 1 or produce a negative fresh-input figure.
- Streaming text that ends inside a possible tool-call marker is no longer
  truncated. The scanner buffers a trailing prefix to avoid mis-parsing, and Chat
  now flushes that tail as a delta instead of dropping it; Responses no longer
  overwrites its authoritative terminal text with the shorter live copy.
- Tool calls the upstream emits inside the reasoning channel are now stripped from
  the reasoning text and executed, on Anthropic, Chat and Responses. Previously
  only the content channel ran through the DSML scanner, so a call written into
  the thinking channel leaked its raw markers to the client and never ran.
  A malformed fragment in the reasoning channel is dropped with a warning instead
  of failing the turn, because reasoning is auxiliary content.

### Added

- `vendor/dsh-session-stats-0.2.1-rc.5/`: a minimal fork of the DeepSeek Harness
  `sessionStats` projection that fixes the displayed `tok/s`. The decode clock
  starts at the first visible delta, and a pure tool-call step delivers its
  arguments as one frame, so such a step contributed its output tokens to a ~0 ms
  denominator: on two real sessions that was 63.4% / 44.5% of all output tokens,
  rendering 527 / 252 tok/s. Those steps no longer enter the decode statistics,
  and three new fields split the provider's count across tool-call frames, visible
  text and reasoning by channel payload share. Every pre-existing field keeps its
  name and meaning; `stateVersion` goes from 1 to 2 so stale checkpoint rows are
  re-folded rather than mixed. Deployment lives in that directory's README.

### Changed

- OpenAI Chat Completions and Responses now normalize `reasoning_effort` against
  the selected model's upstream capability declaration.
- Unknown reasoning effort names return HTTP 400 instead of being silently
  forwarded or transformed into a disabled-thinking request.
- Responses report the actually forwarded reasoning effort instead of `null`.
- Models without reasoning capability do not receive `reasoning_effort`.
- Model listings include a namespaced `wb_reasoning` capability declaration.
- Model listings now publish upstream image support through `input`,
  `input_modalities`, and `architecture.input_modalities`.
- The admin page now distinguishes the OpenAI Base URL from request endpoints and
  shows the model catalogue URL to prevent `/v1/responses/models` misconfiguration.
- The model catalogue is cached for ten minutes per upstream endpoint and account
  UID; `/v1/models?refresh=true` forces a refresh.
- OpenAI Chat and Responses preserve upstream reasoning-token usage details.
- Responses and Chat now hide upstream reasoning text whenever the client
  explicitly requested `none`, matching the behaviour Anthropic already had. An
  omitted effort is not treated as a request to disable thinking.

- Anthropic `thinking` budgets are mapped to model-supported reasoning effort.
- Thinking responses expose upstream reasoning as Anthropic `thinking` blocks and
  report reasoning-token details in streamed and non-streamed usage.

### Known Limitations

- Some upstream models continue reasoning after `none`. When the client
  **explicitly** asks to disable thinking (`reasoning.effort: "none"` on
  Responses, `reasoning_effort: "none"` on Chat, `thinking.type: "disabled"` on
  Anthropic) the proxy suppresses that reasoning text on all three protocols and
  emits one content-free server warning per request. A request that merely omits
  the field is not an instruction to disable thinking, so its reasoning text is
  still returned.
- Thinking signatures are empty because the upstream does not provide verifiable
  signatures. Strict clients that validate them fall back to plain text rather
  than failing.
- `include: ["reasoning.encrypted_content"]` and `encrypted_content` are not
  supported: the upstream never produces them, so there is nothing to replay.
  Clients relying on encrypted reasoning continuity see the plain-text summary
  instead.
