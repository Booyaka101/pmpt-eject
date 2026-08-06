# Recorded CDP transcripts

Real Chrome DevTools Protocol frames (both directions) recorded by
`scripts/record-fixture.mjs` against a real Chrome over a real WebSocket.

The HTTP responses Chrome fetched came from a local fixture server rather than
platform.openai.com: a transcript recorded against the live dashboard would
contain the operator's own prompt content, which does not belong in a public
repository. The protocol frames, the requestId correlation and the base64
body encoding are all genuinely Chrome's.

- `dashboard-json.jsonl` — a prompt list, two prompt detail bodies, a JSON body
  with no `pmpt_` in it, and a text/plain body that does mention `pmpt_`
  (both of which the filter must reject).
- `octet-stream-base64.jsonl` — the same shape served as
  `application/octet-stream`, which makes Chrome return `base64Encoded: true`.
