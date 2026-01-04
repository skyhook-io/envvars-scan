#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_DIR = '/tmp/envvars-scan-repos';
const RESULTS_FILE = join(TEMP_DIR, 'results.json');

// Parse repo URL/string into org and repo name
function parseRepo(repoStr) {
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

// Clone a repo
function cloneRepo(repoInfo) {
  const orgDir = join(TEMP_DIR, repoInfo.org);
  const repoDir = join(orgDir, repoInfo.repo);

  if (!existsSync(orgDir)) {
    mkdirSync(orgDir, { recursive: true });
  }

  if (existsSync(repoDir)) {
    console.log(`  Repo already exists: ${repoDir}`);
    return repoDir;
  }

  console.log(`  Cloning ${repoInfo.url}...`);
  try {
    execSync(`git clone --depth 1 ${repoInfo.url} "${repoDir}"`, {
      stdio: 'pipe',
      timeout: 120000 // 2 min timeout
    });
    return repoDir;
  } catch (error) {
    console.error(`  Failed to clone: ${error.message}`);
    return null;
  }
}

// Run scanner on a repo
async function scanRepo(repoDir) {
  return new Promise((resolve) => {
    const scanner = spawn('node', [join(__dirname, 'dist/cli.js'), repoDir, '--json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    scanner.stdout.on('data', (data) => { stdout += data; });
    scanner.stderr.on('data', (data) => { stderr += data; });

    scanner.on('close', (code) => {
      if (code !== 0) {
        resolve({ error: stderr || 'Scanner failed', envVars: [], uniqueCount: 0, usageCount: 0 });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        const uniqueNames = new Set(result.envVars.map(v => v.name));
        resolve({
          envVars: result.envVars,
          uniqueCount: uniqueNames.size,
          usageCount: result.envVars.length,
          errors: result.errors
        });
      } catch (e) {
        resolve({ error: 'Failed to parse scanner output', envVars: [], uniqueCount: 0, usageCount: 0 });
      }
    });
  });
}

// Main function
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: node test-harness.js <command> [args]

Commands:
  add <repo> [repo...]    Clone repos (org/repo or GitHub URL)
  scan                    Scan all cloned repos
  list                    List cloned repos
  results                 Show last scan results
  clean                   Remove all cloned repos

Examples:
  node test-harness.js add facebook/react vercel/next.js
  node test-harness.js scan
  node test-harness.js results
`);
    return;
  }

  const command = args[0];

  // Ensure temp dir exists
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }

  switch (command) {
    case 'add': {
      const repos = args.slice(1);
      if (repos.length === 0) {
        console.error('Please specify repos to add');
        process.exit(1);
      }

      console.log(`Adding ${repos.length} repo(s)...\n`);

      for (const repoStr of repos) {
        try {
          const repoInfo = parseRepo(repoStr);
          console.log(`[${repoInfo.org}/${repoInfo.repo}]`);
          const repoDir = cloneRepo(repoInfo);
          if (repoDir) {
            console.log(`  Done: ${repoDir}\n`);
          }
        } catch (error) {
          console.error(`  Error: ${error.message}\n`);
        }
      }
      break;
    }

    case 'scan': {
      console.log('Scanning all repos...\n');

      const results = [];
      const orgs = existsSync(TEMP_DIR) ?
        execSync(`ls -1 "${TEMP_DIR}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean) :
        [];

      for (const org of orgs) {
        if (org === 'results.json') continue;

        const orgDir = join(TEMP_DIR, org);
        const repos = execSync(`ls -1 "${orgDir}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);

        for (const repo of repos) {
          const repoDir = join(orgDir, repo);
          console.log(`[${org}/${repo}]`);
          console.log(`  Scanning...`);

          const startTime = Date.now();
          const scanResult = await scanRepo(repoDir);
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);

          if (scanResult.error) {
            console.log(`  Error: ${scanResult.error}`);
          } else {
            console.log(`  Found ${scanResult.uniqueCount} unique env vars (${scanResult.usageCount} usages) in ${duration}s`);
          }
          console.log();

          results.push({
            org,
            repo,
            path: repoDir,
            ...scanResult,
            duration: parseFloat(duration)
          });
        }
      }

      // Save results
      writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

      // Print summary
      printSummary(results);
      break;
    }

    case 'list': {
      const orgs = existsSync(TEMP_DIR) ?
        execSync(`ls -1 "${TEMP_DIR}"`, { encoding: 'utf-8' }).trim().split('\n').filter(f => f && f !== 'results.json') :
        [];

      if (orgs.length === 0) {
        console.log('No repos cloned yet. Use "add" command to clone repos.');
        return;
      }

      console.log(`Cloned repos in ${TEMP_DIR}:\n`);

      for (const org of orgs) {
        const orgDir = join(TEMP_DIR, org);
        const repos = execSync(`ls -1 "${orgDir}"`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
        console.log(`${org}/`);
        for (const repo of repos) {
          console.log(`  ${repo}`);
        }
      }
      break;
    }

    case 'results': {
      if (!existsSync(RESULTS_FILE)) {
        console.log('No results yet. Run "scan" first.');
        return;
      }

      const results = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
      printSummary(results);
      break;
    }

    case 'clean': {
      console.log(`Removing ${TEMP_DIR}...`);
      execSync(`rm -rf "${TEMP_DIR}"`);
      console.log('Done.');
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function printSummary(results) {
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80) + '\n');

  // Group by org
  const byOrg = {};
  for (const r of results) {
    if (!byOrg[r.org]) byOrg[r.org] = [];
    byOrg[r.org].push(r);
  }

  // Print table
  console.log('| Organization | Repo | Unique Vars | Usages | Time |');
  console.log('|--------------|------|-------------|--------|------|');

  let totalUnique = 0;
  let totalUsages = 0;
  let totalTime = 0;

  for (const org of Object.keys(byOrg).sort()) {
    for (const r of byOrg[org].sort((a, b) => a.repo.localeCompare(b.repo))) {
      const status = r.error ? `Error: ${r.error.slice(0, 30)}` : `${r.uniqueCount}`;
      console.log(`| ${org.padEnd(12)} | ${r.repo.padEnd(20)} | ${String(r.uniqueCount).padStart(11)} | ${String(r.usageCount).padStart(6)} | ${r.duration.toFixed(1).padStart(4)}s |`);
      totalUnique += r.uniqueCount || 0;
      totalUsages += r.usageCount || 0;
      totalTime += r.duration || 0;
    }
  }

  console.log('|--------------|------|-------------|--------|------|');
  console.log(`| TOTAL        | ${results.length} repos`.padEnd(23) + `| ${String(totalUnique).padStart(11)} | ${String(totalUsages).padStart(6)} | ${totalTime.toFixed(1).padStart(4)}s |`);
  console.log();
}

main().catch(console.error);
