# Contributing

Thanks for your interest in improving meta-capi-gateway.

## Setup

```bash
git clone <your fork>
cd meta-capi-gateway
npm ci
npm run typecheck && npm run lint && npm test
```

Node.js 22 or newer is required.

## Guidelines

- Keep runtime dependencies at zero unless there is a strong reason; use `node:http` and the global `fetch`.
- Every behaviour change needs a test. Network calls are always mocked; tests must never reach Meta.
- Never log raw personal data. New log fields containing user data must be covered by the redaction list in `src/logger.ts`.
- When changing normalization rules, cite the relevant section of Meta's customer information parameters documentation in the pull request and add known-answer test vectors.
- Do not commit secrets. Use `.env.example` for new settings and document them in the README.

## Pull requests

1. Open an issue first for larger changes.
2. Keep pull requests focused; update `CHANGELOG.md` under "Unreleased".
3. `npm run typecheck`, `npm run lint`, `npm run build` and `npm test` must pass (CI runs them on Node 22 and 24).

## Reporting security issues

Please do not open public issues for vulnerabilities. Contact the maintainer via https://saizul.com.
