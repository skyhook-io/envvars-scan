export interface EnvVar {
  name: string;
  file: string;
  line: number;
  language: string;
  pattern: string;
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
