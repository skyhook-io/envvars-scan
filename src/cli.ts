#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { scan, checkSemgrepInstalled, uniqueEnvVarNames, groupByName, CONFIG_FILE_NAME, DEFAULT_EXCLUDE_PATTERNS } from './scanner.js';
import { scanPropertyFiles, scanDockerfiles, scanDotEnvFiles, scanDockerComposeFiles } from './property-scanner.js';
import type { EnvVar, ScanResult } from './types.js';

const REPO_CACHE_DIR = '/tmp/envvars-scan-repos';

const EXAMPLE_CONFIG = `# Environment Variable Scanner Configuration
# Place this file at .skyhook/envvars-scan.yaml in your repository

# Custom patterns for detecting environment variables
# These are specific to your codebase and not covered by built-in patterns
customPatterns:
  # Example: Custom env var helper
  # - id: my-custom-helper
  #   description: "Custom helper that gets env var with default value"
  #   pattern: 'getEnvVar("$VAR", ...)'
  #   languages: [javascript, typescript]

# Additional directories to exclude from scanning (merged with defaults)
# Default excludes: node_modules, .next, dist, .git, vendor, build, .mastra, coverage
# includeExcludePatterns:
#   - "generated"
#   - "third_party"

# Override default exclude patterns entirely (use with caution)
# excludePatterns:
#   - "node_modules"
#   - "dist"
`;

program
  .name('envvars-scan')
  .description('Scan codebases for environment variable usage')
  .version('0.1.0')
  .argument('[path]', 'Path to scan', '.')
  .option('--all', 'Include all env vars (not just uppercase)')
  .option('--json', 'Output as JSON')
  .option('--init-config', 'Create example config file at .skyhook/envvars-scan.yaml')
  .option('-v, --verbose', 'Show parser warnings')
  .option('--no-semgrep', 'Skip semgrep scan (only scan property files)')
  .option('--no-properties', 'Skip property file scan')
  .option('--no-dotenv', 'Skip .env file scan')
  .option('--no-docker', 'Skip Dockerfile scan')
  .option('--compose', 'Include docker-compose.yml env vars (off by default)')
  .option('-r, --repo <url>', 'Clone and scan a remote GitHub repo (org/repo or full URL)')
  .option('--keep', 'Keep cloned repo after scanning (default: clean up)')
  .option('--branch <branch>', 'Branch to clone (default: default branch)')
  .option('-d, --diff <base>', 'Compare current state against a git ref (branch/commit)')
  .action(async (path: string, options) => {
    try {
      await run(path, options);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red('An unexpected error occurred'));
      }
      process.exit(1);
    }
  });

// Compare subcommand
program
  .command('compare <base> <head>')
  .description('Compare two JSON scan outputs')
  .option('--json', 'Output as JSON')
  .action(async (base: string, head: string, options) => {
    try {
      await runCompare(base, head, options);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`));
      } else {
        console.error(chalk.red('An unexpected error occurred'));
      }
      process.exit(1);
    }
  });

program.parse();

interface Options {
  all?: boolean;
  json?: boolean;
  initConfig?: boolean;
  verbose?: boolean;
  semgrep?: boolean;
  properties?: boolean;
  dotenv?: boolean;
  docker?: boolean;
  compose?: boolean;
  repo?: string;
  keep?: boolean;
  branch?: string;
  diff?: string;
}

interface CompareResult {
  added: string[];
  removed: string[];
  unchanged: string[];
}

async function run(path: string, options: Options): Promise<void> {
  let absPath = resolve(path);
  let clonedRepoPath: string | null = null;

  // Handle --diff option: compare against git ref
  if (options.diff) {
    await runDiff(path, options.diff, options);
    return;
  }

  // Handle --repo option: clone remote repo first
  if (options.repo) {
    const repoInfo = parseRepoUrl(options.repo);
    clonedRepoPath = await cloneRepo(repoInfo, options);
    if (!clonedRepoPath) {
      throw new Error('Failed to clone repository');
    }
    absPath = clonedRepoPath;
  }

  // Handle --init-config
  if (options.initConfig) {
    await initConfig(absPath);
    return;
  }

  if (!existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }

  if (!options.json) {
    console.log(chalk.blue(`Scanning ${absPath} for environment variables...`));
  }

  const allEnvVars: EnvVar[] = [];
  const allErrors: string[] = [];

  // Run semgrep scan
  if (options.semgrep !== false) {
    if (!(await checkSemgrepInstalled())) {
      if (!options.json) {
        console.log(chalk.yellow('Warning: semgrep not installed. Skipping code scan.'));
        console.log(chalk.yellow('Install with: brew install semgrep'));
      }
    } else {
      const semgrepResult = await scan(absPath, {
        filterUppercase: !options.all,
      });
      allEnvVars.push(...semgrepResult.envVars);
      allErrors.push(...semgrepResult.errors);
    }
  }

  // Scan property files
  if (options.properties !== false) {
    const propertyVars = await scanPropertyFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    // Filter uppercase if needed
    const filtered = options.all
      ? propertyVars
      : propertyVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  // Scan .env files
  if (options.dotenv !== false) {
    const dotenvVars = await scanDotEnvFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all
      ? dotenvVars
      : dotenvVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  // Scan Dockerfiles
  if (options.docker !== false) {
    const dockerVars = await scanDockerfiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all
      ? dockerVars
      : dockerVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  // Scan docker-compose files (opt-in)
  if (options.compose) {
    const composeVars = await scanDockerComposeFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const composeFiltered = options.all
      ? composeVars
      : composeVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...composeFiltered);
  }

  // Deduplicate
  const result = deduplicateResults({
    path: absPath,
    envVars: allEnvVars,
    errors: allErrors,
  });

  // Output results
  if (options.json) {
    // Add repo info if cloned
    const output = clonedRepoPath ? { ...result, clonedFrom: options.repo, clonedPath: options.keep ? clonedRepoPath : undefined } : result;
    console.log(JSON.stringify(output, null, 2));

    // Cleanup cloned repo if not keeping
    if (clonedRepoPath && !options.keep) {
      rmSync(clonedRepoPath, { recursive: true, force: true });
    }
    return;
  }

  // Print warnings only in verbose mode
  if (options.verbose && result.errors.length > 0) {
    for (const e of result.errors) {
      console.log(chalk.yellow(`Warning: ${e}`));
    }
  }

  if (result.envVars.length === 0) {
    console.log(chalk.yellow('No environment variables found'));
    return;
  }

  // Group by name and sort
  const groups = groupByName(result);
  const names = uniqueEnvVarNames(result).sort();

  console.log();
  console.log(chalk.bold(`Found ${names.length} unique environment variables:`));
  console.log();

  for (const name of names) {
    const locations = groups.get(name) || [];
    process.stdout.write(chalk.green(`  ${name}`));
    console.log(chalk.gray(` (${locations.length} usage${locations.length === 1 ? '' : 's'})`));

    // Show first few locations
    const maxLocations = 3;
    for (let i = 0; i < locations.length && i < maxLocations; i++) {
      const loc = locations[i];
      console.log(chalk.gray(`      ${loc.file}:${loc.line}`));
    }
    if (locations.length > maxLocations) {
      console.log(chalk.gray(`      ... and ${locations.length - maxLocations} more`));
    }
  }

  console.log();
  console.log(chalk.blue(`Total: ${names.length} unique env vars, ${result.envVars.length} usages`));

  // Cleanup cloned repo if not keeping
  if (clonedRepoPath && !options.keep) {
    if (!options.json) {
      console.log(chalk.gray(`\nCleaning up ${clonedRepoPath}...`));
    }
    rmSync(clonedRepoPath, { recursive: true, force: true });
  } else if (clonedRepoPath && options.keep) {
    if (!options.json) {
      console.log(chalk.gray(`\nRepo kept at: ${clonedRepoPath}`));
    }
  }
}

function deduplicateResults(result: ScanResult): ScanResult {
  const seen = new Set<string>();
  const deduped: EnvVar[] = [];

  for (const ev of result.envVars) {
    const key = `${ev.name}:${ev.file}:${ev.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ev);
    }
  }

  return {
    ...result,
    envVars: deduped,
  };
}

async function initConfig(basePath: string): Promise<void> {
  const skyhookDir = join(basePath, '.skyhook');
  const configPath = join(skyhookDir, CONFIG_FILE_NAME);

  // Check if file already exists
  if (existsSync(configPath)) {
    console.log(chalk.yellow(`Config file already exists: ${configPath}`));
    return;
  }

  // Create .skyhook directory if it doesn't exist
  if (!existsSync(skyhookDir)) {
    mkdirSync(skyhookDir, { recursive: true });
  }

  // Write example config
  writeFileSync(configPath, EXAMPLE_CONFIG);

  console.log(chalk.green(`Created config file: ${configPath}`));
  console.log(chalk.blue('Edit the file to add custom patterns for your codebase'));
}

interface RepoInfo {
  org: string;
  repo: string;
  url: string;
}

function parseRepoUrl(repoStr: string): RepoInfo {
  // Handle full URLs: https://github.com/org/repo or git@github.com:org/repo
  let match = repoStr.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (match) {
    return { org: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}.git` };
  }

  // Handle org/repo format
  match = repoStr.match(/^([^/]+)\/([^/]+)$/);
  if (match) {
    return { org: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}.git` };
  }

  throw new Error(`Invalid repo format: ${repoStr}. Use org/repo or full GitHub URL`);
}

async function cloneRepo(repoInfo: RepoInfo, options: Options): Promise<string | null> {
  const orgDir = join(REPO_CACHE_DIR, repoInfo.org);
  const repoDir = join(orgDir, repoInfo.repo);

  if (!existsSync(orgDir)) {
    mkdirSync(orgDir, { recursive: true });
  }

  // If repo exists and we're keeping, reuse it
  if (existsSync(repoDir)) {
    if (!options.json) {
      console.log(chalk.gray(`Using cached repo: ${repoDir}`));
    }
    return repoDir;
  }

  if (!options.json) {
    console.log(chalk.blue(`Cloning ${repoInfo.url}...`));
  }

  try {
    const branchArg = options.branch ? `-b ${options.branch}` : '';
    execSync(`git clone --depth 1 ${branchArg} ${repoInfo.url} "${repoDir}"`, {
      stdio: options.json ? 'pipe' : 'inherit',
      timeout: 120000 // 2 min timeout
    });
    return repoDir;
  } catch (error) {
    if (!options.json) {
      console.error(chalk.red(`Failed to clone: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }
    return null;
  }
}

// Compare two JSON scan outputs
async function runCompare(baseFile: string, headFile: string, options: { json?: boolean }): Promise<void> {
  const { readFileSync } = await import('fs');

  if (!existsSync(baseFile)) {
    throw new Error(`Base file not found: ${baseFile}`);
  }
  if (!existsSync(headFile)) {
    throw new Error(`Head file not found: ${headFile}`);
  }

  const baseResult: ScanResult = JSON.parse(readFileSync(baseFile, 'utf-8'));
  const headResult: ScanResult = JSON.parse(readFileSync(headFile, 'utf-8'));

  const baseNames = new Set(baseResult.envVars.map(v => v.name));
  const headNames = new Set(headResult.envVars.map(v => v.name));

  const added = [...headNames].filter(n => !baseNames.has(n)).sort();
  const removed = [...baseNames].filter(n => !headNames.has(n)).sort();
  const unchanged = [...headNames].filter(n => baseNames.has(n)).sort();

  const result: CompareResult = { added, removed, unchanged };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Pretty print
  console.log();
  console.log(chalk.bold('Env Var Changes:'));
  console.log();

  if (added.length === 0 && removed.length === 0) {
    console.log(chalk.gray('  No changes detected'));
  } else {
    for (const name of added) {
      const loc = headResult.envVars.find(v => v.name === name);
      const locStr = loc ? ` (${loc.file}:${loc.line})` : '';
      console.log(chalk.green(`  + ${name}`) + chalk.gray(locStr));
    }
    for (const name of removed) {
      const loc = baseResult.envVars.find(v => v.name === name);
      const locStr = loc ? ` (was in ${loc.file}:${loc.line})` : '';
      console.log(chalk.red(`  - ${name}`) + chalk.gray(locStr));
    }
  }

  console.log();
  console.log(chalk.blue(`Summary: ${added.length} added, ${removed.length} removed, ${unchanged.length} unchanged`));

  // Exit with code 1 if there are changes (useful for CI)
  if (added.length > 0 || removed.length > 0) {
    process.exit(1);
  }
}

// Diff against a git ref using git worktree (safe - never modifies working directory)
async function runDiff(path: string, baseRef: string, options: Options): Promise<void> {
  const absPath = resolve(path);

  // Check if we're in a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: absPath, stdio: 'pipe' });
  } catch {
    throw new Error('Not a git repository');
  }

  // Verify the base ref exists
  try {
    execSync(`git rev-parse --verify ${baseRef}`, { cwd: absPath, stdio: 'pipe' });
  } catch {
    throw new Error(`Git ref not found: ${baseRef}`);
  }

  // Generate a unique worktree path
  const worktreeId = `envvars-scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreePath = join('/tmp', worktreeId);

  if (!options.json) {
    console.log(chalk.blue('Scanning current state...'));
  }

  // Scan current state (working directory as-is, including uncommitted changes)
  const headResult = await scanPath(absPath, options);

  if (!options.json) {
    console.log(chalk.blue(`Creating worktree for ${baseRef}...`));
  }

  try {
    // Create worktree at base ref (detached HEAD)
    execSync(`git worktree add --detach "${worktreePath}" ${baseRef}`, { cwd: absPath, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to create worktree for ${baseRef}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  try {
    if (!options.json) {
      console.log(chalk.blue(`Scanning base state (${baseRef})...`));
    }

    // Scan base state in worktree
    const baseResult = await scanPath(worktreePath, options);

    // Compare
    const baseNames = new Set(baseResult.envVars.map(v => v.name));
    const headNames = new Set(headResult.envVars.map(v => v.name));

    const added = [...headNames].filter(n => !baseNames.has(n)).sort();
    const removed = [...baseNames].filter(n => !headNames.has(n)).sort();
    const unchanged = [...headNames].filter(n => baseNames.has(n)).sort();

    if (options.json) {
      console.log(JSON.stringify({ added, removed, unchanged }, null, 2));
      return;
    }

    // Pretty print
    console.log();
    console.log(chalk.bold(`Env Var Changes (${baseRef} → current):`));
    console.log();

    if (added.length === 0 && removed.length === 0) {
      console.log(chalk.gray('  No changes detected'));
    } else {
      for (const name of added) {
        const loc = headResult.envVars.find(v => v.name === name);
        // Show path relative to repo root
        const relPath = loc ? loc.file.replace(absPath + '/', '') : '';
        const locStr = loc ? ` (${relPath}:${loc.line})` : '';
        console.log(chalk.green(`  + ${name}`) + chalk.gray(locStr));
      }
      for (const name of removed) {
        const loc = baseResult.envVars.find(v => v.name === name);
        // Show path relative to repo root (strip worktree path)
        const relPath = loc ? loc.file.replace(worktreePath + '/', '') : '';
        const locStr = loc ? ` (was in ${relPath}:${loc.line})` : '';
        console.log(chalk.red(`  - ${name}`) + chalk.gray(locStr));
      }
    }

    console.log();
    console.log(chalk.blue(`Summary: ${added.length} added, ${removed.length} removed, ${unchanged.length} unchanged`));

  } finally {
    // Always clean up the worktree
    if (!options.json) {
      console.log(chalk.gray('Cleaning up worktree...'));
    }
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: absPath, stdio: 'pipe' });
    } catch {
      // Try harder - remove directory and prune
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        execSync('git worktree prune', { cwd: absPath, stdio: 'pipe' });
      } catch {
        // Best effort cleanup
      }
    }
  }
}

// Helper to scan a path and return results (for diff mode)
async function scanPath(absPath: string, options: Options): Promise<ScanResult> {
  const allEnvVars: EnvVar[] = [];
  const allErrors: string[] = [];

  if (options.semgrep !== false) {
    if (await checkSemgrepInstalled()) {
      const semgrepResult = await scan(absPath, { filterUppercase: !options.all });
      allEnvVars.push(...semgrepResult.envVars);
      allErrors.push(...semgrepResult.errors);
    }
  }

  if (options.properties !== false) {
    const propertyVars = await scanPropertyFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all ? propertyVars : propertyVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  if (options.dotenv !== false) {
    const dotenvVars = await scanDotEnvFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all ? dotenvVars : dotenvVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  if (options.docker !== false) {
    const dockerVars = await scanDockerfiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all ? dockerVars : dockerVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  if (options.compose) {
    const composeVars = await scanDockerComposeFiles(absPath, DEFAULT_EXCLUDE_PATTERNS);
    const filtered = options.all ? composeVars : composeVars.filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v.name));
    allEnvVars.push(...filtered);
  }

  return deduplicateResults({ path: absPath, envVars: allEnvVars, errors: allErrors });
}
