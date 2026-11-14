# Contributing to Panindigan Automate

Thank you for your interest in contributing to Panindigan Automate. This project is built from scratch in strict TypeScript with a focus on reliability, protocol accuracy, and zero bloat.

We welcome bug fixes, performance improvements, documentation updates, and protocol patches. Before opening a PR, please take a moment to review this guide.

---

## Development Setup

### Prerequisites

- **Node.js 22 LTS or newer** (Node 26 LTS recommended)
- **npm** (included with Node.js)
- A local code editor with TypeScript support (VS Code, Cursor, Neovim, etc.)

### Getting Started

1. **Fork and clone** the repository:
   ```bash
   git clone https://github.com/your-username/panindigan-automate.git
   cd panindigan-automate
   ```

2. **Install dependencies**:
   ```bash
   # pnpm (Recommended)
   pnpm install

   # Bun
   bun install

   # npm
   npm install
   ```

3. **Verify your setup**:
   ```bash
   pnpm run typecheck
   pnpm test
   pnpm run build
   ```

All tests should pass cleanly out of the box.

---

## Available Scripts

Commands can be run with `pnpm` (recommended), `bun`, or `npm`:

| Command (pnpm) | Purpose |
| :--- | :--- |
| `pnpm run typecheck` | Validates TypeScript types across the entire project with `--noEmit`. |
| `pnpm test` | Runs the test suite once using [Vitest](https://vitest.dev/). |
| `pnpm run bench` | Runs micro-benchmarks (if configured). |
| `pnpm run build` | Compiles dual ESM/CJS bundles and emits `.d.ts` declaration files via `build.mjs`. |

---

## Codebase Architecture

The project is structured into modular layers under `src/`:

```
src/
├── cache/          # In-memory LRU cache and namespaced adapters
├── client/         # Public MessengerClient facade, form builders, and models
├── config/         # Client configuration schema and validation
├── constants.ts    # Single source of truth for endpoints, doc IDs, and topics
├── delta/          # Realtime MQTT delta stream decoding and event normalization
├── diagnostics/    # In-memory metrics, request counters, and snapshot collector
├── errors/         # Typed error hierarchy (APIError, NetworkError, CookieError, etc.)
├── events/         # Strongly-typed event emitter and event payload definitions
├── logger/         # Pino-based structured logger
├── middleware/     # Composable before/after/error middleware engine
├── plugins/        # Sandboxed plugin lifecycle and execution context
├── session/        # Session state machine, credential parser, cookie refresh
├── storage/        # Memory and file-based session storage drivers
├── sync/           # GraphQL sync queue initialization and sequence tracking
├── transport/      # Low-level network engines:
│   ├── http/       # Undici HTTP client, retry loops, multipart uploads
│   └── mqtt/       # MQTT-over-WebSocket, region dialer, LS tasks, proxy agent
├── types/          # Public interfaces, models, and discriminated unions
└── utils/          # Pure helper utilities (BigInt threading IDs, timers)
```

---

## Coding Standards

To keep the codebase maintainable, secure, and fast, contributions must follow these conventions:

### 1. Strict TypeScript (No Compromises)
- **Zero `any`**: Use `unknown`, generic parameters, or explicit interfaces.
- **Runtime assertions**: Validate untrusted external data (network responses, user options) using Zod or explicit type-guards.
- **Explicit imports with `.js`**: All relative imports within `src/` must include the `.js` extension (e.g., `import { ... } from "./models.js";`) to comply with standard Node.js ESM resolution.

### 2. Dual Package Compatibility
The library distributes dual CommonJS and ESM artifacts. Avoid features that break CommonJS consumption (e.g. top-level `await` in shared library modules) or that rely on environment-specific globals without fallbacks.

### 3. Pure Functions for Business Logic
- Keep network operations isolated to `transport/` and `client/index.ts`.
- Logic for parsing responses, formatting form fields, resolving URLs, or mapping deltas into events should be pure functions in `forms.ts`, `models.ts`, or `delta/`. This makes them easy to unit test without network mocks.

### 4. Typed Error Handling
Never throw raw strings or generic `Error` instances in library code. Use or extend the appropriate error class from `src/errors/`:
- `ValidationError`: For invalid user input or configuration.
- `CookieError`: For malformed or missing authentication cookies.
- `NetworkError`: For socket failures, timeouts, and connection drops.
- `APIError`: For rejections returned by Facebook endpoints.

---

## Testing Guidelines

- Tests live in `tests/` and use **Vitest**.
- Every bug fix should include a regression test reproducing the issue.
- Every new feature should include tests covering both normal execution and edge cases (e.g., empty inputs, malformed payloads, rate-limit responses).
- Avoid making live network requests against Facebook in automated tests. Instead, test the parsing, normalization, and form generation logic against realistic fixture payloads.

Run only a specific test file during development:
```bash
npx vitest run tests/client.test.ts
```

---

## Pull Request Process

1. **Create a descriptive branch**:
   ```bash
   git checkout -b fix/group-mention-offset
   ```
2. **Make your changes** following the coding standards above.
3. **Run all quality checks**:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
   PRs with failing checks cannot be merged.
4. **Write clear commit messages**:
   - `fix(client): handle null thread image in GraphQL response`
   - `feat(delta): add support for community chat thread updates`
5. **Open your Pull Request** with a concise description of:
   - What was changed and why.
   - Any Facebook protocol nuances or payload shapes relevant to the change.
   - Confirmation that all checks pass locally.
