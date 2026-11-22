# Changelog

## Unreleased

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
  signatures.
