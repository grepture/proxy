# Grepture Proxy

An LLM API proxy that detects and redacts PII, blocks sensitive content, and tokenizes fields — all before requests reach your AI provider.

## Quick Start

```bash
# Copy and edit the example rules
cp rules.example.json rules.json

# Start the proxy
bun run src/index.ts
```

The proxy starts on port `4001` by default. Send requests through it by setting the `X-Grepture-Target` header to your upstream API:

```bash
curl http://localhost:4001/proxy/ \
  -H "Authorization: Bearer any-token" \
  -H "X-Grepture-Target: https://api.anthropic.com/v1/messages" \
  -H "X-Grepture-Auth-Forward: Bearer sk-ant-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "My email is john@example.com"}]
  }'
```

The proxy will redact `john@example.com` before it reaches the API, based on your rules.

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `GREPTURE_API_KEY` | No | — | If set, only requests with this Bearer token are allowed. If unset, any token is accepted. |
| `GREPTURE_RULES_FILE` | No | `rules.json` | Path to rules configuration file |
| `GREPTURE_PLUGINS` | No | — | Comma-separated paths to plugin modules to load at startup |
| `PORT` | No | `4001` | Port to listen on |

## Rules

Rules are defined in a JSON file (default: `rules.json`). See `rules.example.json` for the full format.

Each rule has:
- **conditions** — when to apply (match on headers, body, URL, model)
- **actions** — what to do (redact PII, find/replace, tokenize, block, log)
- **apply_to** — `input` (before forwarding), `output` (on response), or `both`
- **sampling_rate** — percentage of requests to apply to (1-100)

### Available Actions

| Action | Description |
|--------|-------------|
| `redact_pii` | Detect and redact PII using regex patterns (email, phone, SSN, credit card, IP, address, DOB) |
| `find_replace` | Find and replace text (literal or regex) |
| `tokenize` | Replace JSON fields with tokens, store originals for later restoration |
| `redact_field` | Replace specific JSON fields with a fixed value |
| `block_request` | Block the request with a custom status code and message |
| `log_only` | Tag the request for logging without modifying it |

Rules are reloaded automatically when the file changes, or on `SIGHUP`.

## Docker

```bash
docker build -t grepture-proxy .

docker run -p 4001:4001 \
  -v $(pwd)/rules.json:/app/rules.json \
  grepture-proxy
```

## How It Works

```
Client → Proxy → [Auth] → [Input Rules] → [Forward] → [Output Rules] → [Detokenize] → Client
```

1. Authenticate the request (optionally validate API key if `GREPTURE_API_KEY` is set)
2. Apply input rules (redact PII, block, tokenize)
3. Forward to the upstream API (set via `X-Grepture-Target`)
4. Apply output rules to the response
5. Restore tokenized values
6. Return the response

Supports both buffered and streaming (SSE) responses. Token restoration works across streamed chunks.
