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
- **.env files**: Variable definitions like `VAR_NAME=value`
- **Dockerfiles**: `ENV` and `ARG` declarations
- **docker-compose.yml**: Environment variable references (`${VAR}`) and definitions

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
import { scan, scanPropertyFiles, uniqueEnvVarNames } from '@skyhook-io/envvars-scan';

// Full scan (semgrep + property files)
const result = await scan('./my-project', {
  filterUppercase: true,
});

console.log(uniqueEnvVarNames(result));

// Property files only
const propertyVars = await scanPropertyFiles('./my-project');
```

## Default Excludes

The following directories are excluded by default:
- `node_modules`, `.next`, `dist`, `.git`, `vendor`, `build`
- `.mastra`, `coverage`, `__pycache__`, `.venv`, `venv`, `target`

## License

MIT
