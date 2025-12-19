---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

## Active Technologies
- Markdown (documentation only) + N/A (no code dependencies) (001-v01-scope-doc)
- N/A (file-based documentation) (001-v01-scope-doc)
- TypeScript 5.x (Bun runtime) + Biome (lint+format), Bun (runtime, test runner) (002-contributor-tooling)
- N/A (tooling config only) (002-contributor-tooling)
- TypeScript 5.x (Bun runtime) + None beyond TypeScript - pure type definitions (003-core-types)
- N/A (type definitions only, no runtime storage) (003-core-types)
- TypeScript 5.x (Bun runtime) + zod@4.1.9 (already installed), Bun.file for I/O (004-provider-manifest)
- File-based JSON manifests (`providers/**/manifest.json`) (004-provider-manifest)

## Recent Changes
- 004-provider-manifest: Added provider manifest schema with Zod validation, CLI list command, and semantic property accessors
- 003-core-types: Added TypeScript 5.x (Bun runtime) + None beyond TypeScript - pure type definitions
- 001-v01-scope-doc: Added Markdown (documentation only) + N/A (no code dependencies)

## Provider Manifest System (004-provider-manifest)

New provider manifest types and loader for config-driven provider onboarding:

### Types (`types/manifest.ts`)
- `ProviderManifest` - Main manifest type with capabilities, semantic properties, conformance tests
- `LoadedProvider` - Loaded manifest with path and content hash
- `ManifestValidationError`, `FieldError` - Structured validation errors
- `SUPPORTED_MANIFEST_VERSIONS` - Currently `["1"]`

### Loader (`src/loaders/providers.ts`)
- `loadAllProviders()` - Discover and validate all `providers/**/manifest.json` files
- `validateManifest()` - Validate JSON against schema
- `formatValidationError()` - Format errors with field, rule, expected value (FR-009)
- `formatProviderTable()` / `formatProviderJson()` - CLI output formatting
- `getUpdateStrategy()`, `getDeleteStrategy()`, `getConvergenceWaitMs()` - Semantic property accessors

### CLI (`index.ts`)
- `bun run index.ts list providers` - List all configured providers in table format
- `bun run index.ts list providers --json` - List in JSON format for machine parsing

### Tests (`tests/manifest/`)
- Valid/invalid manifest fixtures in `fixtures/`
- Unit tests for schema validation, CLI output, semantic properties
