import { spawn } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EnvVar, ScanOptions, ScanResult, SemgrepOutput, UserConfig, ValueSource } from './types.js';

/**
 * Clean up a default value captured from Semgrep
 * Removes surrounding quotes and handles common patterns
 */
function cleanDefaultValue(value: string): string {
  let cleaned = value.trim();

  // Remove surrounding quotes (single or double)
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // Handle backtick strings (JS template literals)
  if (cleaned.startsWith('`') && cleaned.endsWith('`')) {
    cleaned = cleaned.slice(1, -1);
  }

  // Remove String() wrapper if present
  if (cleaned.startsWith('String(') && cleaned.endsWith(')')) {
    cleaned = cleaned.slice(7, -1);
  }

  // Handle .to_string() or .to_owned() (Rust)
  cleaned = cleaned.replace(/\.(to_string|to_owned)\(\)$/, '');

  return cleaned;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.next',
  'dist',
  '.git',
  'vendor',
  'build',
  '.mastra',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
];

export const CONFIG_FILE_NAME = 'envvars-scan.yaml';

export async function checkSemgrepInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['semgrep']);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

export async function scan(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const {
    filterUppercase = true,
    excludePatterns = DEFAULT_EXCLUDE_PATTERNS,
    customRulesPath,
  } = options;

  // Verify semgrep is installed
  if (!(await checkSemgrepInstalled())) {
    throw new Error('semgrep not found in PATH. Install with: brew install semgrep');
  }

  // Resolve absolute path
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  // Load built-in rules
  const rulesPath = join(__dirname, '..', 'rules', 'rules.yaml');
  let rulesContent = readFileSync(rulesPath, 'utf-8');

  // Load and merge user config if exists
  const userConfig = loadUserConfig(absPath);
  if (userConfig?.customPatterns?.length) {
    const customRules = generateCustomRulesYaml(userConfig.customPatterns);
    // Strip the "rules:" header from custom rules and append
    const customRulesBody = customRules.replace(/^rules:\n/, '');
    rulesContent = rulesContent + '\n' + customRulesBody;
  }

  // Write combined rules to temp file
  const tempDir = mkdtempSync(join(tmpdir(), 'envvars-scan-'));
  const tempRulesPath = join(tempDir, 'rules.yaml');
  writeFileSync(tempRulesPath, rulesContent);

  try {
    // Build semgrep command
    const args = ['--config', tempRulesPath, '--json', '--quiet'];

    // Merge exclude patterns
    const allExcludes = [...excludePatterns];
    if (userConfig?.includeExcludePatterns) {
      allExcludes.push(...userConfig.includeExcludePatterns);
    }
    if (userConfig?.excludePatterns) {
      // User override - replace defaults
      allExcludes.length = 0;
      allExcludes.push(...userConfig.excludePatterns);
    }

    for (const pattern of allExcludes) {
      args.push('--exclude', pattern);
    }

    args.push(absPath);

    // Run semgrep
    const output = await runSemgrep(args);

    // Parse results
    const result: ScanResult = {
      path: absPath,
      envVars: [],
      errors: [],
    };

    // Use a map to track results by key, preferring results with default values
    const resultMap = new Map<string, { envVar: EnvVar; hasDefault: boolean }>();
    const uppercaseRe = /^[A-Z][A-Z0-9_]*$/;

    for (const r of output.results) {
      const message = r.extra.message;

      // Check for default value separator (|||)
      let envVarName: string;
      let defaultValue: string | undefined;

      if (message.includes('|||')) {
        const parts = message.split('|||');
        envVarName = parts[0];
        defaultValue = cleanDefaultValue(parts[1]);
      } else {
        envVarName = message;
      }

      // Filter to uppercase only if enabled
      if (filterUppercase && !uppercaseRe.test(envVarName)) {
        continue;
      }

      const { language, pattern } = parseCheckId(r.check_id);

      const envVar: EnvVar = {
        name: envVarName,
        file: r.path,
        line: r.start.line,
        language,
        pattern,
        value: defaultValue,
        valueSource: defaultValue ? 'code-default' : undefined,
        isDefault: !!defaultValue,
      };

      // Dedupe by key, but prefer results with default values
      const key = `${envVarName}:${r.path}:${r.start.line}`;
      const existing = resultMap.get(key);

      if (!existing) {
        resultMap.set(key, { envVar, hasDefault: !!defaultValue });
      } else if (defaultValue && !existing.hasDefault) {
        // Replace with version that has a default value
        resultMap.set(key, { envVar, hasDefault: true });
      }
    }

    // Add all deduped results
    for (const { envVar } of resultMap.values()) {
      result.envVars.push(envVar);
    }

    // Collect errors
    for (const e of output.errors) {
      result.errors.push(e.message);
    }

    return result;
  } finally {
    // Cleanup temp files
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runSemgrep(args: string[]): Promise<SemgrepOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn('semgrep', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));

    proc.on('close', () => {
      try {
        const output = JSON.parse(stdout) as SemgrepOutput;
        resolve(output);
      } catch (e) {
        reject(new Error(`Failed to parse semgrep output: ${e}\nstderr: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run semgrep: ${err.message}`));
    });
  });
}

function parseCheckId(checkId: string): { language: string; pattern: string } {
  // Check for custom patterns first
  if (checkId.includes('custom-')) {
    const idx = checkId.lastIndexOf('custom-');
    return { language: 'custom', pattern: checkId.slice(idx) };
  }

  // Find the rule ID by looking for known language prefixes
  const langPrefixes = ['go-', 'js-', 'python-', 'java-', 'ruby-', 'rust-', 'csharp-', 'php-', 'kotlin-', 'scala-', 'properties-'];

  let ruleId = checkId;
  for (const prefix of langPrefixes) {
    const idx = checkId.lastIndexOf(prefix);
    if (idx !== -1) {
      ruleId = checkId.slice(idx);
      break;
    }
  }

  const parts = ruleId.split('-');
  if (parts.length < 2) {
    return { language: 'unknown', pattern: ruleId };
  }

  const langMap: Record<string, string> = {
    go: 'go',
    js: 'javascript',
    python: 'python',
    java: 'java',
    ruby: 'ruby',
    rust: 'rust',
    csharp: 'csharp',
    php: 'php',
    kotlin: 'kotlin',
    scala: 'scala',
    properties: 'properties',
  };

  const lang = parts[0];
  const language = langMap[lang] || lang;
  const pattern = parts.slice(1).join('.');

  return { language, pattern };
}

function loadUserConfig(dir: string): UserConfig | null {
  const configPath = join(dir, '.skyhook', CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    // Simple YAML parsing for our limited use case
    // For a real implementation, use a proper YAML parser
    return parseSimpleYaml(content);
  } catch {
    return null;
  }
}

function parseSimpleYaml(content: string): UserConfig {
  // This is a simplified parser - in production, use js-yaml
  // For now, we'll add js-yaml as a dependency
  const config: UserConfig = {};

  // Basic extraction - this should be replaced with proper yaml parsing
  // TODO: Add js-yaml dependency for proper parsing

  return config;
}

function generateCustomRulesYaml(patterns: { id: string; pattern: string; languages: string[] }[]): string {
  let rules = 'rules:\n';

  for (const p of patterns) {
    rules += `  - id: custom-${p.id}\n`;
    rules += `    patterns:\n`;
    rules += `      - pattern: ${p.pattern}\n`;
    rules += `    languages: [${p.languages.join(', ')}]\n`;
    rules += `    message: "$VAR"\n`;
    rules += `    severity: INFO\n\n`;
  }

  return rules;
}

// Helper functions for result processing
export function uniqueEnvVarNames(result: ScanResult): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const ev of result.envVars) {
    if (!seen.has(ev.name)) {
      seen.add(ev.name);
      names.push(ev.name);
    }
  }

  return names;
}

export function groupByName(result: ScanResult): Map<string, EnvVar[]> {
  const groups = new Map<string, EnvVar[]>();

  for (const ev of result.envVars) {
    const existing = groups.get(ev.name) || [];
    existing.push(ev);
    groups.set(ev.name, existing);
  }

  return groups;
}
