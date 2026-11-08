# Changelog

## Unreleased

### Changed

- OpenAI Chat Completions and Responses now normalize `reasoning_effort` against
  the selected model's upstream capability declaration.
- Unknown reasoning effort names return HTTP 400 instead of being silently
  forwarded or transformed into a disabled-thinking request.
- Responses report the actually forwarded reasoning effort instead of `null`.
- Models without reasoning capability do not receive `reasoning_effort`.
- Model listings include a namespaced `wb_reasoning` capability declaration.
- The model catalogue is cached for ten minutes per upstream endpoint and account
  UID; `/v1/models?refresh=true` forces a refresh.
- OpenAI Chat and Responses preserve upstream reasoning-token usage details.

### Added

- Anthropic `thinking` budgets are mapped to model-supported reasoning effort.
- Thinking responses expose upstream reasoning as Anthropic `thinking` blocks and
  report reasoning-token details in streamed and non-streamed usage.

### Known Limitations

- Some upstream models continue reasoning after `none`. The proxy suppresses that
  reasoning text when thinking is disabled and emits one content-free server
  warning for the request.
- Thinking signatures are empty because the upstream does not provide verifiable
  signatures.
