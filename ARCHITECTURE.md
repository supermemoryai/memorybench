# MemoryBench Architecture

## Overview

MemoryBench uses a factory-based architecture to enable easy addition of new memory providers and benchmarks with minimal code duplication.

## Directory Structure

```
memorybench/
├── core/                          # Core framework
│   ├── providers/                 # Provider infrastructure
│   │   ├── BaseProvider.ts       # Abstract base class for all providers
│   │   ├── ProviderRegistry.ts   # Singleton registry for providers
│   │   └── ProviderLoader.ts     # Auto-discovery and loading
│   └── runners/                   # Benchmark infrastructure
│       └── BenchmarkRunner.ts    # Base class for benchmark runners
│
├── providers/                     # Provider implementations
│   ├── supermemory/
│   │   └── Provider.ts           # SuperMemory provider
│   ├── mem0/
│   │   └── Provider.ts           # Mem0 provider
│   ├── langchain/
│   │   └── Provider.ts           # LangChain provider
│   └── fullcontext/
│       └── Provider.ts           # FullContext baseline provider
│
├── benchmarks/                    # Benchmark implementations
│   ├── LongMemEval/
│   ├── LoCoMo/
│   └── NoLiMa/
│
├── results/                       # Centralized results
│   └── {runId}/                  # Per-run results
│       ├── checkpoints/
│       ├── search/
│       └── evaluation/
│
└── cli/                          # CLI entry point
    └── run-benchmark.ts
```

## Key Design Patterns

### 1. Factory Pattern

**Purpose**: Create provider instances without coupling to specific implementations

**Implementation**:
- `ProviderRegistry`: Central factory that creates and caches provider instances
- `ProviderLoader`: Auto-discovers providers from the `providers/` directory

```typescript
// Get a provider instance
const registry = getProviderRegistry();
const provider = await registry.getProvider('supermemory');
```

### 2. Template Method Pattern

**Purpose**: Define the skeleton of benchmark execution while allowing subclasses to customize specific steps

**Implementation**:
- `BenchmarkRunner`: Base class with `run()` method that calls abstract methods
- Concrete benchmark runners implement `runIngest()`, `runSearch()`, `runEvaluate()`

```typescript
export abstract class BenchmarkRunner {
    public async run(): Promise<void> {
        await this.runIngest();   // Subclass implements
        await this.runSearch();    // Subclass implements
        await this.runEvaluate();  // Subclass implements
    }
}
```

### 3. Singleton Pattern

**Purpose**: Ensure only one instance of the provider registry exists

**Implementation**:
- `ProviderRegistry.getInstance()`: Returns the same instance across calls

```typescript
const registry = ProviderRegistry.getInstance();
```

### 4. Strategy Pattern

**Purpose**: Allow different providers to be swapped at runtime

**Implementation**:
- `BaseProvider`: Common interface
- Concrete providers: Different search/ingest strategies

## Adding a New Provider

### Step 1: Create Provider Class

Create `providers/{provider-name}/Provider.ts`:

```typescript
import { BaseProvider, type ProviderConfig, type IngestOptions,
         type SearchOptions, type SearchResult } from '../../core/providers/BaseProvider';

export default class MyProvider extends BaseProvider {
    constructor() {
        const config: ProviderConfig = {
            name: 'myprovider',
            requiresApiKey: true,
            apiKeyEnvVar: 'MY_PROVIDER_API_KEY',
            supportsMetadata: true,
        };
        super(config);
    }

    public async ingest(content: string, containerTag: string, options?: IngestOptions): Promise<void> {
        // Implement ingestion logic
    }

    public async search(query: string, containerTag: string, options?: SearchOptions): Promise<SearchResult[]> {
        // Implement search logic
        return [];
    }
}
```

### Step 2: That's It!

The provider will be automatically discovered and registered when the system starts. No need to modify any other files!

## Running Benchmarks

### Basic Usage

```bash
# Auto-generates runId: BenchmarkName_provider_datetime
bun run benchmark NoLiMa supermemory --limit=10

# Custom runId
bun run benchmark LongMemEval mem0 --runId=my-custom-run --limit=5

# With options
bun run benchmark LoCoMo langchain --limit=2 --answeringModel=gpt-4o
```

### Available Commands

```bash
# List all registered providers
bun run list-providers

# Test a specific provider
bun run test-provider supermemory

# Run all benchmarks for a provider
bun run test-all supermemory
```

## Provider Interface

### Required Methods

```typescript
// Ingest content
public abstract ingest(
    content: string,
    containerTag: string,
    options?: IngestOptions
): Promise<void>;

// Search for content
public abstract search(
    query: string,
    containerTag: string,
    options?: SearchOptions
): Promise<SearchResult[]>;
```

### Optional Methods

```typescript
// Initialize provider (called once)
public async initialize(): Promise<void>

// Cleanup resources
public async cleanup(): Promise<void>

// Prepare container for use
public async prepareContainer(containerTag: string): Promise<void>

// Delete container
public async deleteContainer(containerTag: string): Promise<void>
```

## Configuration

### Provider Configuration

Each provider specifies its configuration in the constructor:

```typescript
const config: ProviderConfig = {
    name: 'myprovider',                    // Provider name (lowercase)
    requiresApiKey: true,                  // Whether API key is required
    apiKeyEnvVar: 'MY_PROVIDER_API_KEY',  // Environment variable name
    supportsMetadata: true,                // Supports custom metadata
    supportsChunking: false,               // Supports automatic chunking
    maxContentLength: 4096,                // Max content length (optional)
};
```

### Environment Variables

Set required API keys in `.env`:

```env
OPENAI_API_KEY=sk-...
SUPERMEMORY_API_KEY=...
MEM0_API_KEY=...
```

## Results Structure

All results are stored in a unified directory structure:

```
results/{benchmark}_{provider}_{datetime}/
├── checkpoints/
│   ├── ingest/
│   │   └── checkpoint-*.json
│   ├── search/
│   │   └── search-*.json
│   └── evaluate/
│       └── eval-*.json
├── search/
│   └── {questionId}-*.json
└── evaluation/
    └── eval-{model}.json
```

## Testing

### Unit Tests

Test individual providers:

```bash
bun test providers/supermemory/Provider.test.ts
```

### Integration Tests

Test provider against benchmark:

```bash
bun run test-provider supermemory --benchmark=NoLiMa --limit=5
```

### Test All Providers

```bash
bun run test-all --benchmark=NoLiMa --limit=2
```

## Benefits of This Architecture

1. **No Code Duplication**: Provider-specific code is centralized
2. **Easy Extension**: Add new providers by creating one file
3. **Type Safety**: TypeScript ensures interface compliance
4. **Auto-Discovery**: New providers are automatically registered
5. **Testable**: Each provider can be tested in isolation
6. **Configurable**: Provider behavior can be configured per instance
7. **Maintainable**: Changes to one provider don't affect others

## Migration Guide

### For Existing Providers

To migrate an existing provider to the new architecture:

1. Create `providers/{name}/Provider.ts`
2. Extend `BaseProvider`
3. Implement required methods
4. Move existing logic from `src/ingest.ts` and `src/search.ts`

Example migration for existing provider:

```typescript
// Old structure:
providers/myprovider/
├── src/
│   ├── ingest.ts
│   ├── search.ts
│   └── config.ts
└── index.ts

// New structure:
providers/myprovider/
└── Provider.ts  // All logic consolidated here
```

## Advanced Features

### Provider Caching

Providers are cached by default:

```typescript
const provider1 = await registry.getProvider('supermemory');
const provider2 = await registry.getProvider('supermemory');
// provider1 === provider2 (same instance)

// Force new instance
const provider3 = await registry.getProvider('supermemory', true);
// provider3 !== provider1 (new instance)
```

### Provider Lifecycle

```
Load → Initialize → [Use] → Cleanup
  ↑                              ↓
  └──────── Reload ──────────────┘
```

## Troubleshooting

### Provider Not Found

```
Error: Provider 'xyz' not found
```

**Solution**: Ensure `providers/xyz/Provider.ts` exists and exports default class

### API Key Missing

```
Error: MY_PROVIDER_API_KEY environment variable is required
```

**Solution**: Add the API key to `.env` file

### Import Errors

```
Error: Cannot find module '../../core/providers/BaseProvider'
```

**Solution**: Ensure core infrastructure files exist and paths are correct
