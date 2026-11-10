# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

### Added
- `POST /events` endpoint for browser events with payload validation, CORS allow-list and per-IP rate limiting.
- Customer information normalization and SHA-256 hashing (`em`, `ph`, `fn`, `ln`, `ct`, `st`, `zp`, `country`, `external_id`, `db`, `ge`), including Bangladesh phone number handling.
- Unhashed `client_ip_address`, `client_user_agent`, `fbp`, `fbc`, `event_source_url`, `action_source=website` and `event_id` for browser/server deduplication.
- Batching queue (API limit of 1000 events per request), retries with exponential backoff and jitter, optional `test_event_code`, and a JSON Lines dead-letter file with a replay command.
- WooCommerce webhook receiver with HMAC-SHA256 signature verification, mapped to `Purchase` events.
- Structured JSON logs with PII redaction.
- `/health` endpoint, `/snippet.js` browser snippet with consent gating.
- Dockerfile, docker-compose example, CI workflow (Node 22 and 24), README with English and Bangla guides.
