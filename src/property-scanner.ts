import { readFileSync } from 'fs';
import { glob } from 'glob';
import { join, relative } from 'path';
import type { EnvVar, ValueSource } from './types.js';
import { DEFAULT_EXCLUDE_PATTERNS } from './scanner.js';

/**
 * Parse a value from .env file format, handling quotes and escape sequences
 */
function parseEnvValue(rawValue: string): string {
  let value = rawValue.trim();

  // Handle quoted values
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  // Handle inline comments (only for unquoted values)
  if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
    const commentIdx = value.indexOf('#');
    if (commentIdx > 0) {
      value = value.slice(0, commentIdx).trim();
    }
  }

  return value;
}

/**
 * Scans property/config files for ${VAR} and ${VAR:default} syntax
 * Used by Spring, Quarkus, and other JVM frameworks
 */
export async function scanPropertyFiles(
  basePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
): Promise<EnvVar[]> {
  const envVars: EnvVar[] = [];

  // Find property and yaml files
  const patterns = [
    '**/application*.properties',
    '**/application*.yaml',
    '**/application*.yml',
    '**/bootstrap*.properties',
    '**/bootstrap*.yaml',
    '**/bootstrap*.yml',
    '**/*.properties',
  ];

  const ignorePatterns = excludePatterns.map((p) => `**/${p}/**`);

  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: basePath,
      ignore: ignorePatterns,
      nodir: true,
      absolute: true,
    });

    for (const file of files) {
      const vars = scanPropertyFile(file, basePath);
      envVars.push(...vars);
    }
  }

  return envVars;
}

function scanPropertyFile(filePath: string, basePath: string): EnvVar[] {
  const envVars: EnvVar[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Pattern: ${VAR_NAME} or ${VAR_NAME:default}
  // Captures: group 1 = var name, group 2 = default value (optional)
  const envVarPattern = /\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g;

  const relativePath = relative(basePath, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;

    while ((match = envVarPattern.exec(line)) !== null) {
      const varName = match[1];
      const defaultValue = match[2]; // May be undefined

      envVars.push({
        name: varName,
        file: filePath,
        line: i + 1,
        language: 'properties',
        pattern: 'spring.placeholder',
        value: defaultValue,
        valueSource: defaultValue ? 'properties' : undefined,
        isDefault: !!defaultValue,
      });
    }
  }

  return envVars;
}

/**
 * Scans Dockerfile for ENV and ARG declarations
 */
export async function scanDockerfiles(
  basePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
): Promise<EnvVar[]> {
  const envVars: EnvVar[] = [];

  const ignorePatterns = excludePatterns.map((p) => `**/${p}/**`);

  const files = await glob('**/Dockerfile*', {
    cwd: basePath,
    ignore: ignorePatterns,
    nodir: true,
    absolute: true,
  });

  for (const file of files) {
    const vars = scanDockerfile(file, basePath);
    envVars.push(...vars);
  }

  return envVars;
}

function scanDockerfile(filePath: string, basePath: string): EnvVar[] {
  const envVars: EnvVar[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Pattern: ENV VAR_NAME=value or ENV VAR_NAME value
  // Captures: group 1 = var name, group 2 = value (with = or space separator)
  const envPatternEquals = /^ENV\s+([A-Z][A-Z0-9_]*)=(.*)$/i;
  const envPatternSpace = /^ENV\s+([A-Z][A-Z0-9_]*)\s+(.+)$/i;
  // Pattern: ARG VAR_NAME or ARG VAR_NAME=default
  const argPattern = /^ARG\s+([A-Z][A-Z0-9_]*)(?:=(.*))?$/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check ENV declarations (= syntax)
    let envMatch = envPatternEquals.exec(line);
    if (envMatch) {
      const value = envMatch[2]?.trim();
      envVars.push({
        name: envMatch[1],
        file: filePath,
        line: i + 1,
        language: 'dockerfile',
        pattern: 'ENV',
        value: value || undefined,
        valueSource: value ? 'dockerfile-env' : undefined,
      });
      continue;
    }

    // Check ENV declarations (space syntax)
    envMatch = envPatternSpace.exec(line);
    if (envMatch) {
      const value = envMatch[2]?.trim();
      envVars.push({
        name: envMatch[1],
        file: filePath,
        line: i + 1,
        language: 'dockerfile',
        pattern: 'ENV',
        value: value || undefined,
        valueSource: value ? 'dockerfile-env' : undefined,
      });
      continue;
    }

    // Check ARG declarations
    const argMatch = argPattern.exec(line);
    if (argMatch) {
      const value = argMatch[2]?.trim();
      envVars.push({
        name: argMatch[1],
        file: filePath,
        line: i + 1,
        language: 'dockerfile',
        pattern: 'ARG',
        value: value || undefined,
        valueSource: value ? 'dockerfile-arg' : undefined,
        isDefault: !!value,
      });
    }
  }

  return envVars;
}

/**
 * Scans .env files for variable definitions
 */
export async function scanDotEnvFiles(
  basePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
): Promise<EnvVar[]> {
  const envVars: EnvVar[] = [];

  const ignorePatterns = excludePatterns.map((p) => `**/${p}/**`);

  // Match both .env* files (like .env, .env.local) and *.env files (like container.env)
  const files = await glob(['**/.env*', '**/*.env'], {
    cwd: basePath,
    ignore: ignorePatterns,
    nodir: true,
    absolute: true,
    dot: true,
  });

  for (const file of files) {
    const vars = scanDotEnvFile(file, basePath);
    envVars.push(...vars);
  }

  return envVars;
}

function scanDotEnvFile(filePath: string, basePath: string): EnvVar[] {
  const envVars: EnvVar[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Pattern: VAR_NAME=value (with optional export prefix)
  // Captures: group 1 = var name, group 2 = value
  const envPattern = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') continue;

    const match = envPattern.exec(line);
    if (match) {
      const rawValue = match[2];
      const value = parseEnvValue(rawValue);

      envVars.push({
        name: match[1],
        file: filePath,
        line: i + 1,
        language: 'dotenv',
        pattern: 'definition',
        value: value || undefined,
        valueSource: 'dotenv',
      });
    }
  }

  return envVars;
}

/**
 * Scans docker-compose.yml files for environment variable definitions
 */
export async function scanDockerComposeFiles(
  basePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
): Promise<EnvVar[]> {
  const envVars: EnvVar[] = [];

  const ignorePatterns = excludePatterns.map((p) => `**/${p}/**`);

  const files = await glob('**/docker-compose*.{yml,yaml}', {
    cwd: basePath,
    ignore: ignorePatterns,
    nodir: true,
    absolute: true,
  });

  for (const file of files) {
    const vars = scanDockerComposeFile(file, basePath);
    envVars.push(...vars);
  }

  return envVars;
}

function scanDockerComposeFile(filePath: string, basePath: string): EnvVar[] {
  const envVars: EnvVar[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Pattern: ${VAR_NAME} or $VAR_NAME in values (references only, no value extraction)
  const varRefPattern = /\$\{?([A-Z][A-Z0-9_]*)\}?/g;
  // Pattern: - VAR_NAME=value or VAR_NAME: value (env definitions with values)
  // Captures: group 1 = var name, group 2 = separator (= or :), group 3 = value
  const envDefPattern = /^\s*-?\s*([A-Z][A-Z0-9_]*)([=:])(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for VAR_NAME= or VAR_NAME: definitions (with values)
    const defMatch = envDefPattern.exec(line);
    if (defMatch) {
      let value = defMatch[3]?.trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      envVars.push({
        name: defMatch[1],
        file: filePath,
        line: i + 1,
        language: 'docker-compose',
        pattern: 'environment-definition',
        value: value || undefined,
        valueSource: value ? 'docker-compose' : undefined,
      });
      continue; // Don't double-count as reference
    }

    // Check for ${VAR} references (no value extraction for references)
    let match;
    while ((match = varRefPattern.exec(line)) !== null) {
      envVars.push({
        name: match[1],
        file: filePath,
        line: i + 1,
        language: 'docker-compose',
        pattern: 'variable-reference',
      });
    }
  }

  return envVars;
}
