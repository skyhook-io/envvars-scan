import { readFileSync } from 'fs';
import { glob } from 'glob';
import type { EnvVar, ValueSource } from './types.js';
import { DEFAULT_EXCLUDE_PATTERNS } from './scanner.js';

/**
 * Scans Kubernetes manifests for environment variable definitions
 * Supports: Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, ConfigMaps, Secrets
 */
export async function scanK8sManifests(
  basePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS
): Promise<EnvVar[]> {
  const envVars: EnvVar[] = [];
  const ignorePatterns = excludePatterns.map((p) => `**/${p}/**`);

  // Find all YAML files
  const files = await glob('**/*.{yaml,yml}', {
    cwd: basePath,
    ignore: ignorePatterns,
    nodir: true,
    absolute: true,
  });

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');

      // Check if it's a K8s manifest (has apiVersion and kind)
      if (!isK8sManifest(content)) continue;

      const kind = getK8sKind(content);

      // Handle multi-document YAML files (separated by ---)
      // Track line offsets for each document
      const lines = content.split('\n');
      let docStartLine = 0;
      let docContent = '';
      let currentDocKind: string | null = null;

      for (let i = 0; i <= lines.length; i++) {
        const line = lines[i];
        const isEnd = i === lines.length;
        const isDocSeparator = line === '---';

        if (isEnd || isDocSeparator) {
          // Process the current document
          if (docContent.trim()) {
            const docKind = getK8sKind(docContent) || kind;

            switch (docKind) {
              case 'Deployment':
              case 'StatefulSet':
              case 'DaemonSet':
              case 'Job':
              case 'CronJob':
              case 'Pod':
              case 'ReplicaSet':
                envVars.push(...scanK8sWorkload(docContent, file, docKind, docStartLine));
                break;
              case 'ConfigMap':
                envVars.push(...scanConfigMap(docContent, file, docStartLine));
                break;
              case 'Secret':
                envVars.push(...scanSecret(docContent, file, docStartLine));
                break;
            }
          }

          // Start new document
          docStartLine = i + 1;
          docContent = '';
        } else {
          docContent += (docContent ? '\n' : '') + line;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return envVars;
}

/**
 * Check if content looks like a Kubernetes manifest
 */
function isK8sManifest(content: string): boolean {
  return /^apiVersion:/m.test(content) && /^kind:/m.test(content);
}

/**
 * Extract the 'kind' field from a K8s manifest
 */
function getK8sKind(content: string): string | null {
  const match = content.match(/^kind:\s*(\w+)/m);
  return match ? match[1] : null;
}

/**
 * Scan workload resources (Deployment, StatefulSet, etc.) for env: sections
 */
function scanK8sWorkload(content: string, file: string, kind: string, lineOffset: number = 0): EnvVar[] {
  const envVars: EnvVar[] = [];
  const lines = content.split('\n');

  // Track context to find env entries within containers
  let inEnvSection = false;
  let currentIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect start of env: section
    if (trimmed.startsWith('env:')) {
      inEnvSection = true;
      currentIndent = indent;
      continue;
    }

    // Exit env section when we see a line at same or lesser indent that's not a list item
    if (inEnvSection && indent <= currentIndent && !trimmed.startsWith('-')) {
      inEnvSection = false;
    }

    // Parse env entries: - name: X\n  value: Y
    if (inEnvSection && trimmed.startsWith('- name:')) {
      const nameMatch = trimmed.match(/^-\s*name:\s*["']?([A-Z][A-Z0-9_]*)["']?/);
      if (nameMatch) {
        const varName = nameMatch[1];

        // Look for value on next line
        let value: string | undefined;
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          const valueMatch = nextLine.match(/^value:\s*["']?([^"'\n]*)["']?/);
          if (valueMatch) {
            value = valueMatch[1];
          }
        }

        envVars.push({
          name: varName,
          file,
          line: lineOffset + i + 1,
          language: 'kubernetes',
          pattern: kind.toLowerCase(),
          value: value || undefined,
          valueSource: value ? 'k8s-deployment' : undefined,
        });
      }
    }
  }

  return envVars;
}

/**
 * Scan ConfigMap data: section for key-value pairs
 */
function scanConfigMap(content: string, file: string, lineOffset: number = 0): EnvVar[] {
  const envVars: EnvVar[] = [];
  const lines = content.split('\n');

  let inDataSection = false;
  let dataIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect start of data: section
    if (trimmed.startsWith('data:')) {
      inDataSection = true;
      dataIndent = indent;
      continue;
    }

    // Exit data section when we see a line at same or lesser indent
    if (inDataSection && indent <= dataIndent && trimmed && !trimmed.startsWith('#')) {
      inDataSection = false;
    }

    // Parse data entries: KEY: value
    if (inDataSection && trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([A-Z][A-Z0-9_]*):\s*(.*)$/);
      if (match) {
        let value: string | undefined = match[2].trim();

        // Remove quotes if present
        if (value && ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))) {
          value = value.slice(1, -1);
        }

        // Handle multiline values (|, >, |-, >-)
        if (value === '|' || value === '>' || value === '|-' || value === '>-') {
          // Look for multiline content on following lines
          let multilineValue = '';
          let j = i + 1;
          const expectedIndent = indent + 2;

          while (j < lines.length) {
            const nextLine = lines[j];
            const nextTrimmed = nextLine.trimStart();
            const nextIndent = nextLine.length - nextTrimmed.length;

            if (nextIndent >= expectedIndent && nextTrimmed) {
              multilineValue += (multilineValue ? '\n' : '') + nextTrimmed;
              j++;
            } else if (!nextTrimmed) {
              // Empty line, continue if next non-empty is still indented
              j++;
            } else {
              break;
            }
          }

          value = multilineValue || undefined;
        }

        envVars.push({
          name: match[1],
          file,
          line: lineOffset + i + 1,
          language: 'kubernetes',
          pattern: 'configmap',
          value: value || undefined,
          valueSource: value ? 'k8s-configmap' : undefined,
        });
      }
    }
  }

  return envVars;
}

/**
 * Scan Secret data: section for key-value pairs (base64 decode)
 */
function scanSecret(content: string, file: string, lineOffset: number = 0): EnvVar[] {
  const envVars: EnvVar[] = [];
  const lines = content.split('\n');

  let inDataSection = false;
  let inStringDataSection = false;
  let dataIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect start of data: or stringData: section
    if (trimmed.startsWith('data:')) {
      inDataSection = true;
      inStringDataSection = false;
      dataIndent = indent;
      continue;
    }
    if (trimmed.startsWith('stringData:')) {
      inStringDataSection = true;
      inDataSection = false;
      dataIndent = indent;
      continue;
    }

    // Exit section when we see a line at same or lesser indent
    if ((inDataSection || inStringDataSection) && indent <= dataIndent && trimmed && !trimmed.startsWith('#')) {
      inDataSection = false;
      inStringDataSection = false;
    }

    // Parse data entries: KEY: value
    if ((inDataSection || inStringDataSection) && trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([A-Z][A-Z0-9_]*):\s*(.*)$/);
      if (match) {
        let value = match[2].trim();

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // For data: section, base64 decode
        if (inDataSection && value) {
          try {
            value = Buffer.from(value, 'base64').toString('utf-8');
          } catch {
            // Keep as-is if decode fails
          }
        }

        envVars.push({
          name: match[1],
          file,
          line: lineOffset + i + 1,
          language: 'kubernetes',
          pattern: 'secret',
          value: value || undefined,
          valueSource: value ? 'k8s-secret' : undefined,
        });
      }
    }
  }

  return envVars;
}
