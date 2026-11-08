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
