# envvars-scan

Scan codebases for environment variable usage across multiple languages and frameworks.

## Installation

```bash
# Run directly with npx (no install needed)
npx @skyhook-io/envvars-scan .

# Or install globally
npm install -g @skyhook-io/envvars-scan
```

## Requirements

- Node.js 18+
- [Semgrep](https://semgrep.dev) for code scanning: `brew install semgrep`

## Usage

```bash
# Scan current directory
envvars-scan

# Scan specific path
envvars-scan ./src

# Scan a remote GitHub repo (clones to temp, scans, cleans up)
envvars-scan --repo facebook/react
envvars-scan -r vercel/next.js

# Keep cloned repo after scanning
envvars-scan --repo org/repo --keep

# Clone specific branch
envvars-scan --repo org/repo --branch develop

# Include lowercase config keys (not just uppercase env vars)
envvars-scan --all

# Include docker-compose.yml env vars (off by default)
envvars-scan --compose

# Include Kubernetes manifests (Deployments, ConfigMaps, Secrets)
envvars-scan --k8s

# Show detected values (sensitive values are masked)
envvars-scan --show-values

# Combine flags for full visibility
envvars-scan --k8s --show-values

# Output as JSON
envvars-scan --json

# Show parser warnings
envvars-scan -v

# Create custom config file
envvars-scan --init-config

# Compare against a git branch/commit (local use)
envvars-scan --diff origin/main
envvars-scan --diff HEAD~5

# Compare two JSON scan outputs (CI use)
envvars-scan compare base.json head.json
```

## CI Integration

Detect env var changes in pull requests:

```yaml
name: Env Vars Check
on:
  pull_request:
    branches: [main]

jobs:
  check-env-vars:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install semgrep
        run: pip install semgrep

      - name: Scan base branch
        run: |
          git checkout ${{ github.base_ref }}
          npx @skyhook-io/envvars-scan --json > /tmp/base.json

      - name: Scan PR branch
        run: |
          git checkout ${{ github.head_ref }}
          npx @skyhook-io/envvars-scan --json > /tmp/head.json

      - name: Compare env vars
        run: npx @skyhook-io/envvars-scan compare /tmp/base.json /tmp/head.json
```

## What It Scans

### Code Patterns (via Semgrep)

| Language | Patterns |
|----------|----------|
| Go | `os.Getenv()`, `os.LookupEnv()`, `viper.Get*()`, `envconfig` |
| JavaScript/TypeScript | `process.env`, NestJS `ConfigService`, `env()` helpers |
| Python | `os.getenv()`, `os.environ`, Django `env()`/`config()`, Flask, Pydantic |
| Java | `System.getenv()`, Spring `@Value`, `Environment.getProperty()`, Quarkus `@ConfigProperty`, `Dotenv.get()` |
| Kotlin | `System.getenv()`, Quarkus `@ConfigProperty`, `Dotenv.get()` |
| Ruby | `ENV[]`, `ENV.fetch()`, Rails credentials |
| Rust | `std::env::var()`, `env!()` macro |
| C# | `Environment.GetEnvironmentVariable()`, `IConfiguration` |
| PHP | `getenv()`, `$_ENV`, Laravel `env()`/`config()` |
| Scala | `sys.env()`, `sys.env.get()` |

### Config Files (built-in regex scanner)

- **Property files**: `application.properties`, `bootstrap.properties` with `${VAR}` or `${VAR:default}` syntax (Spring, Quarkus)
- **YAML files**: `application.yaml`, `application.yml` with `${VAR}` syntax
- **.env files**: Variable definitions like `VAR_NAME=value` (matches both `.env*` and `*.env` patterns)
- **Dockerfiles**: `ENV` and `ARG` declarations
- **docker-compose.yml**: Environment variable references (`${VAR}`) and definitions

### Kubernetes Manifests (with `--k8s` flag)

- **Deployments/StatefulSets/DaemonSets**: `env:` sections with direct values
- **ConfigMaps**: `data:` key-value pairs
- **Secrets**: `data:` values (base64 decoded)

## Value Detection

The scanner detects **values** from multiple sources:

| Source | Example | `valueSource` |
|--------|---------|---------------|
| Code defaults | `process.env.PORT \|\| 3000` | `code-default` |
| .env files | `DATABASE_URL=postgres://...` | `dotenv` |
| Dockerfile ENV | `ENV NODE_ENV=production` | `dockerfile-env` |
| Dockerfile ARG | `ARG VERSION=1.0.0` | `dockerfile-arg` |
| K8s Deployments | `env: [{name: X, value: Y}]` | `k8s-deployment` |
| K8s ConfigMaps | `data: {KEY: value}` | `k8s-configmap` |
| K8s Secrets | `data: {KEY: base64}` | `k8s-secret` |
| Spring properties | `${VAR:default}` | `properties` |

### Security

When using `--show-values`, sensitive values are automatically masked for variable names matching:
`secret`, `password`, `key`, `token`, `api`, `auth`, `credential`, `private`

Example output:
```
DATABASE_URL = postgres://localhost:5432/dev (dotenv)
API_KEY = sk****89 (dotenv)  # masked
```

## Custom Patterns

Create `.skyhook/envvars-scan.yaml` in your project:

```yaml
customPatterns:
  - id: my-helper
    description: "Custom env var helper"
    pattern: 'getEnvVar("$VAR", ...)'
    languages: [javascript, typescript]

# Additional directories to exclude
includeExcludePatterns:
  - "generated"
  - "third_party"
```

## Programmatic Usage

```typescript
import {
  scan,
  scanPropertyFiles,
  scanK8sManifests,
  uniqueEnvVarNames,
  groupByName,
  type EnvVar,
  type ValueSource
} from '@skyhook-io/envvars-scan';

// Full scan (semgrep + property files)
const result = await scan('./my-project', {
  filterUppercase: true,
});

console.log(uniqueEnvVarNames(result));

// Access values
for (const envVar of result.envVars) {
  console.log(envVar.name, envVar.value, envVar.valueSource);
}

// Property files only
const propertyVars = await scanPropertyFiles('./my-project');

// Kubernetes manifests
const k8sVars = await scanK8sManifests('./my-project');
```

### EnvVar Type

```typescript
interface EnvVar {
  name: string;
  file: string;
  line: number;
  language: string;
  pattern: string;
  value?: string;           // Detected value (if found)
  valueSource?: ValueSource; // Where the value came from
  isDefault?: boolean;       // Is this a default/fallback value?
}
```

## Default Excludes

The following directories are excluded by default:
- `node_modules`, `.next`, `dist`, `.git`, `vendor`, `build`
- `.mastra`, `coverage`, `__pycache__`, `.venv`, `venv`, `target`

## License

MIT
