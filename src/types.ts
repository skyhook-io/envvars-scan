export type ValueSource =
  | 'code-default'      // Default in code (||, ??, getenv default param)
  | 'dotenv'            // .env file definition
  | 'dockerfile-env'    // Dockerfile ENV
  | 'dockerfile-arg'    // Dockerfile ARG
  | 'k8s-deployment'    // K8s Deployment/StatefulSet/DaemonSet env:
  | 'k8s-configmap'     // K8s ConfigMap
  | 'k8s-secret'        // K8s Secret (base64 decoded)
  | 'docker-compose'    // docker-compose.yml
  | 'properties';       // application.properties default

export interface EnvVar {
  name: string;
  file: string;
  line: number;
  language: string;
  pattern: string;
  /** The detected value (if found) */
  value?: string;
  /** Where the value came from */
  valueSource?: ValueSource;
  /** Is this a default/fallback value? */
  isDefault?: boolean;
}

export interface ScanResult {
  path: string;
  envVars: EnvVar[];
  errors: string[];
}

export interface ScanOptions {
  /** Filter to only uppercase env var names (default: true) */
  filterUppercase?: boolean;
  /** Patterns to exclude from scanning */
  excludePatterns?: string[];
  /** Path to custom rules file */
  customRulesPath?: string;
}

export interface CustomPattern {
  id: string;
  description?: string;
  pattern: string;
  languages: string[];
}

export interface UserConfig {
  customPatterns?: CustomPattern[];
  excludePatterns?: string[];
  includeExcludePatterns?: string[];
}

// Semgrep output types
export interface SemgrepOutput {
  results: SemgrepResult[];
  errors: SemgrepError[];
}

export interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    lines: string;
  };
}

export interface SemgrepError {
  message: string;
  level: string;
}
