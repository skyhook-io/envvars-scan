import { readFileSync } from 'fs';
import { glob } from 'glob';
import { join, relative } from 'path';
import type { EnvVar } from './types.js';
import { DEFAULT_EXCLUDE_PATTERNS } from './scanner.js';

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
  // Also handles nested like ${VAR1:${VAR2:default}}
  const envVarPattern = /\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g;

  const relativePath = relative(basePath, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;

    while ((match = envVarPattern.exec(line)) !== null) {
      const varName = match[1];

      envVars.push({
        name: varName,
        file: filePath,
        line: i + 1,
        language: 'properties',
        pattern: 'spring.placeholder',
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
  const envPattern = /^ENV\s+([A-Z][A-Z0-9_]*)/i;
  // Pattern: ARG VAR_NAME or ARG VAR_NAME=default
  const argPattern = /^ARG\s+([A-Z][A-Z0-9_]*)/i;
  // Pattern: ${VAR_NAME} usage
  const usagePattern = /\$\{?([A-Z][A-Z0-9_]*)\}?/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check ENV declarations
    const envMatch = envPattern.exec(line);
    if (envMatch) {
      envVars.push({
        name: envMatch[1],
        file: filePath,
        line: i + 1,
        language: 'dockerfile',
        pattern: 'ENV',
      });
    }

    // Check ARG declarations
    const argMatch = argPattern.exec(line);
    if (argMatch) {
      envVars.push({
        name: argMatch[1],
        file: filePath,
        line: i + 1,
        language: 'dockerfile',
        pattern: 'ARG',
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

  const files = await glob('**/.env*', {
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
  const envPattern = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (line.startsWith('#') || line === '') continue;

    const match = envPattern.exec(line);
    if (match) {
      envVars.push({
        name: match[1],
        file: filePath,
        line: i + 1,
        language: 'dotenv',
        pattern: 'definition',
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

  // Pattern: ${VAR_NAME} or $VAR_NAME in values
  const varRefPattern = /\$\{?([A-Z][A-Z0-9_]*)\}?/g;
  // Pattern: - VAR_NAME=value or VAR_NAME: value (env definitions)
  const envDefPattern = /^\s*-?\s*([A-Z][A-Z0-9_]*)[=:]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for ${VAR} references
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

    // Check for VAR_NAME= or VAR_NAME: definitions
    const defMatch = envDefPattern.exec(line);
    if (defMatch) {
      envVars.push({
        name: defMatch[1],
        file: filePath,
        line: i + 1,
        language: 'docker-compose',
        pattern: 'environment-definition',
      });
    }
  }

  return envVars;
}
