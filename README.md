# meta-capi-gateway

A small, self-hostable gateway for the **Meta Conversions API (CAPI)**. Your site sends plain events to the gateway; it validates them, normalizes and SHA-256 hashes customer information the way Meta expects, batches them, and delivers them to the Graph API with retries and a dead-letter file. It also accepts signed WooCommerce webhooks and turns completed orders into server-side `Purchase` events.

- TypeScript, Node.js 22+, **zero runtime dependencies** (`node:http` and global `fetch`)
- Browser snippet with consent gating and Pixel/server deduplication via a shared `event_id`
- CORS allow-list, per-IP rate limit, strict payload validation
- Bangladesh-aware phone normalization (`01XXXXXXXXX` becomes `8801XXXXXXXXX`)
- Batching (up to the API limit), exponential backoff with jitter, `test_event_code` support
- Dead-letter JSONL file plus a replay command
- Structured JSON logs that never print raw personal data
- Docker image, compose file, 290+ tests, CI on Node 22 and 24

Built and maintained by [Saizul Amin](https://saizul.com), Meta Ads and automation specialist.

```
Browser (snippet) --POST /events--> gateway --batch--> graph.facebook.com/{version}/{pixel_id}/events
WooCommerce -------POST /webhooks/woocommerce (HMAC) -->    |
                                                       dead-letter.jsonl (on permanent failure)
```

## Quick start

```bash
cp .env.example .env        # fill in PIXEL_ID, ACCESS_TOKEN, ALLOWED_ORIGINS
npm ci && npm run build
node --env-file=.env dist/index.js
# or: docker compose up -d --build
curl http://localhost:8080/health
```

### 1. Get your Pixel (dataset) ID and access token

1. Open **Meta Events Manager** and choose your Pixel / dataset. The numeric ID is the `PIXEL_ID`.
2. Go to **Settings > Conversions API > Generate access token**. Copy it into `ACCESS_TOKEN` (environment only; never commit it, never put it in browser code).
3. For testing, open **Test events** and copy the code (for example `TEST12345`) into `TEST_EVENT_CODE`. Events then appear in that tab within seconds. **Remove it for production**, because test events are not used for optimization or reporting.
4. Check **Diagnostics** and **Event match quality** in Events Manager after real traffic arrives.

### 2. Add the snippet to your site

```html
<!-- Keep your normal Pixel base code, but remove its automatic fbq('track','PageView') -->
<script async src="https://capi.example.com/snippet.js"
        data-auto-pageview="true"></script>
<script>
  // after the snippet has loaded:
  capi.track("AddToCart", { value: 1200, currency: "BDT", content_ids: ["sku-1"] });
  capi.track("Lead", {}, { email: form.email.value, phone: form.phone.value });
</script>
```

`capi.track(name, customData, userData, { eventId })` generates an `event_id`, fires `fbq` (if present) with `{ eventID }`, and posts the same event and id to the gateway. Meta deduplicates the two copies. Custom event names use `fbq('trackCustom')`.

Script attributes: `data-endpoint` (override the URL), `data-require-consent="true"` (queue until `capi.consent(true)`), `data-auto-pageview="true"`.

You can also call the API directly (server to server needs `ALLOW_MISSING_ORIGIN=true`):

```bash
curl -X POST http://localhost:8080/events -H 'content-type: application/json' -H 'origin: https://www.example.com' -d '{
  "event_name": "Purchase",
  "event_id": "order-1001",
  "event_source_url": "https://www.example.com/thank-you",
  "user": { "email": "Rahim@Example.com", "phone": "01712-345678", "city": "Dhaka", "country": "BD" },
  "custom_data": { "value": 2450, "currency": "BDT", "content_ids": ["sku-1"], "num_items": 1 }
}'
```

Responses: `202 {accepted, dropped, event_ids}`, `400` validation details, `403` origin, `413`, `415`, `429` (with `Retry-After`), `503` queue full.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PIXEL_ID` | required | Numeric pixel/dataset ID |
| `ACCESS_TOKEN` | required | Conversions API token |
| `GRAPH_API_VERSION` | `v23.0` | Check Meta's changelog and bump when needed |
| `TEST_EVENT_CODE` | unset | Sends events to Test Events |
| `ALLOWED_ORIGINS` | empty | Comma list; supports `https://*.example.com` |
| `ALLOW_MISSING_ORIGIN` | `false` | Allow non-browser callers without `Origin` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SEC` | `60` / `60` | Per client IP |
| `TRUST_PROXY_HOPS` | `0` | Trusted reverse proxies; reads `X-Forwarded-For` from the right |
| `BATCH_SIZE` / `BATCH_INTERVAL_MS` | `50` / `2000` | `BATCH_SIZE` max 1000 |
| `MAX_QUEUE` | `10000` | In-memory backlog before answering 503 |
| `MAX_RETRIES` | `4` | Per batch, exponential backoff |
| `DEAD_LETTER_PATH` | `./data/dead-letter.jsonl` | Failed batches |
| `DEFAULT_PHONE_COUNTRY_CODE` | `880` | Used for numbers without `+` or `00` |
| `WOOCOMMERCE_WEBHOOK_SECRET` | unset | Enables `/webhooks/woocommerce` |
| `SITE_URL` | unset | Used as `event_source_url` for WooCommerce orders |
| `LOG_LEVEL`, `PORT`, `HOST`, `MAX_BODY_BYTES`, `GRAPH_BASE_URL` | see `.env.example` | |

## What gets normalized and hashed

| Field | Rule applied before SHA-256 |
| --- | --- |
| `em` | trim, lowercase |
| `ph` | digits only with country code, no leading zeros; `01712345678` becomes `8801712345678`; `+880 1712-345678` and `+880 01712345678` are handled; `+1 (650) 555-1212` becomes `16505551212` |
| `fn`, `ln` | lowercase, punctuation removed (Unicode letters, including Bangla, are preserved) |
| `ct` | lowercase, letters only |
| `st` | lowercase, letters only |
| `zp` | lowercase, no spaces or dashes; US ZIP+4 reduced to 5 digits |
| `country` | two-letter ISO 3166-1 alpha-2, lowercase (a few names such as "Bangladesh" are mapped) |
| `external_id` | trimmed, hashed (case preserved) |
| `db`, `ge` | `YYYYMMDD`; `f`/`m` |

Not hashed: `client_ip_address`, `client_user_agent`, `fbp`, `fbc`. Values that already look like a SHA-256 hex digest are passed through untouched to avoid double hashing. Hashed fields are sent as arrays, as in Meta's examples. `action_source` is always `website`.

The `ph` rule for numbers without a prefix assumes `DEFAULT_PHONE_COUNTRY_CODE`; a 10-digit number such as `1712345678` is treated as Bangladeshi, while an 11+ digit number that does not start with `0` is assumed to already include its country code.

## Deduplication

Meta deduplicates a browser and a server event when they share the same `event_name` and `event_id` (and arrive within its dedup window). The snippet creates one `event_id` and uses it for both. For WooCommerce, the gateway uses `wc_order_{order_id}`; if your thank-you page also fires a browser `Purchase`, pass `{ eventID: "wc_order_123" }` to `fbq`. The gateway additionally ignores repeated webhook deliveries for the same order while the process is running.

## WooCommerce

1. In WooCommerce go to **Settings > Advanced > Webhooks > Add webhook**.
2. Delivery URL: `https://capi.example.com/webhooks/woocommerce`, status Active, API version v3 (JSON).
3. Secret: the same value as `WOOCOMMERCE_WEBHOOK_SECRET`.
4. Topic: choose **Order updated** (or a custom `order.completed` action if your setup provides one). The gateway only emits a `Purchase` when the order `status` is `completed`, regardless of topic.

Signatures are verified as base64 HMAC-SHA256 of the raw request body in `X-WC-Webhook-Signature`, using a constant-time comparison. Value is the order `total` (it includes shipping and tax). Billing email, phone, name, city, state, postcode and country are hashed; `customer_ip_address`, `customer_user_agent` and `_fbp`/`_fbc` order meta (if a plugin stores them) are used when present.

## Reliability and operations

- Events are queued in memory and flushed on `BATCH_SIZE` or `BATCH_INTERVAL_MS`. SIGTERM drains the queue.
- Retries cover network errors, HTTP 5xx/429 and transient Graph error codes, honouring `Retry-After`. Permanent errors (for example invalid parameters or an expired token) are not retried.
- Failed batches are appended to the dead-letter JSONL file. After fixing the cause, replay with `node dist/cli-replay.js [path]` (or `npm run replay`). Entries that still fail are kept.
- The queue is in memory: a hard crash can lose events that were not yet flushed. For stronger guarantees put a durable queue in front.
- Logs are JSON lines; keys such as email, phone, IP, user agent, `user_data`, tokens and secrets are replaced with `[redacted]`, and email addresses or token-looking strings inside messages are scrubbed.
- `GET /health` returns status, version, uptime and queue size.

## Privacy notes

- **Consent.** Only send events for people who agreed to marketing/analytics tracking where the law or Meta's terms require it. Use `data-require-consent="true"` with your consent banner and call `capi.consent(true/false)`. Events posted with `"consent": false` are dropped by the gateway.
- **Hashing is not anonymization.** Hashed email and phone numbers are still personal data under many regimes (for example GDPR). Treat the dead-letter file as sensitive: it contains hashed identifiers, IPs and user agents. It is created with mode `0600`; rotate or delete it after replay.
- **Data minimization.** Send only fields you need. The gateway drops unknown fields, never forwards cookies other than `fbp`/`fbc`, and keeps no database.
- **Secrets.** The access token lives in the environment. It is sent in the request body to Graph API over HTTPS and never logged.
- **Transport.** Run behind TLS. Set `TRUST_PROXY_HOPS` correctly so rate limits and the `client_ip_address` sent to Meta reflect real visitors.
- Provide a privacy policy that discloses Meta data sharing, and honour deletion/opt-out requests.

## Facts to verify before production

Meta's documentation could not be fetched automatically while building this project (the pages are rendered client-side and have moved). The values below come from the author's knowledge of the API and should be checked against the current docs at <https://developers.facebook.com/docs/marketing-api/conversions-api/> and the "Customer Information Parameters" page:

- maximum of **1000 events per request**
- events older than **7 days** are rejected (the gateway rejects them up front)
- `event_source_url` is expected for `action_source=website`
- `GRAPH_API_VERSION` default (`v23.0`) may be outdated; set the current version
- `access_token` accepted in the JSON body of the POST
- exact list of transient error codes treated as retryable (`1, 2, 4, 17, 32, 341, 613`)
- `fbc` format `fb.1.<ms timestamp>.<fbclid>` and normalization of `st`/`zp` for non-US regions
- WooCommerce webhook topic names offered by your WooCommerce version

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm run build && npm test
```

Tests mock `fetch` and never contact Meta. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## বাংলা নির্দেশিকা

এটি Meta Conversions API-এর জন্য একটি ছোট, নিজের সার্ভারে চালানোর মতো গেটওয়ে। আপনার ওয়েবসাইট ইভেন্ট পাঠায়; গেটওয়ে সেগুলো যাচাই করে, ইমেইল/ফোন ইত্যাদি Meta-র নিয়মে ঠিক করে SHA-256 হ্যাশ করে, ব্যাচ করে Meta-তে পাঠায়। ব্যর্থ হলে আবার চেষ্টা করে, এরপরও না হলে `dead-letter.jsonl` ফাইলে রেখে দেয়।

**দ্রুত শুরু**

1. `cp .env.example .env` করে `PIXEL_ID`, `ACCESS_TOKEN` ও `ALLOWED_ORIGINS` দিন। Events Manager > Settings > Conversions API থেকে টোকেন তৈরি করুন। টোকেন কখনো গিটে বা ব্রাউজার কোডে রাখবেন না।
2. পরীক্ষার জন্য Events Manager > Test events থেকে কোড নিয়ে `TEST_EVENT_CODE` দিন। লাইভ করার আগে এটি মুছে ফেলুন।
3. `docker compose up -d --build` চালান, তারপর `/health` দেখুন।
4. সাইটে `<script async src="https://আপনার-ডোমেইন/snippet.js"></script>` যোগ করে `capi.track("Lead", {}, {email, phone})` ব্যবহার করুন। Pixel ও সার্ভার একই `event_id` ব্যবহার করে, তাই Meta ডুপ্লিকেট গণনা করে না।

**বাংলাদেশি ফোন নম্বর:** `01712345678`, `+880 1712-345678`, `8801712345678` সবই `8801712345678` হয়ে হ্যাশ হয়। অন্য দেশের কোড ডিফল্ট করতে `DEFAULT_PHONE_COUNTRY_CODE` বদলান।

**WooCommerce:** WooCommerce > Settings > Advanced > Webhooks-এ Delivery URL `https://আপনার-ডোমেইন/webhooks/woocommerce` দিন এবং Secret হিসেবে `WOOCOMMERCE_WEBHOOK_SECRET`-এর মান দিন। অর্ডারের স্ট্যাটাস `completed` হলে `Purchase` ইভেন্ট (মূল্য, কারেন্সি ও পণ্যসহ) যায়।

**গোপনীয়তা:** যেখানে আইনে প্রয়োজন, শুধু সম্মতি দেওয়া ব্যবহারকারীর ইভেন্ট পাঠান (`data-require-consent="true"` ও `capi.consent(true)`)। হ্যাশ করা তথ্যও ব্যক্তিগত তথ্য হিসেবে গণ্য হতে পারে, তাই শুধু প্রয়োজনীয় ফিল্ড পাঠান এবং dead-letter ফাইল সুরক্ষিত রাখুন। প্রোডাকশনে চালানোর আগে উপরের "Facts to verify" তালিকা Meta-র সর্বশেষ ডকুমেন্টেশনের সঙ্গে মিলিয়ে নিন।

## License

[MIT](LICENSE) (c) 2026 Saizul Amin
