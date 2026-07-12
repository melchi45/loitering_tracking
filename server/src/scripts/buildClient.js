'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

// process.execPath may point to the glibc loader on systems where node is
// installed as a wrapper (e.g. /opt/glibc-2.33 + shell shim).
// Resolve the actual 'node' binary via PATH instead.
// Windows-only: `which` (when this script runs under a POSIX shell like
// git-bash) returns an MSYS-style path (e.g. /c/Program Files/nodejs/node)
// that Windows' native spawnSync() cannot resolve (ENOENT) — process.execPath
// is already a valid Windows path there, so skip the `which` lookup entirely.
const NODE_BIN = (() => {
  if (process.platform === 'win32') return process.execPath;
  try {
    const p = execSync('which node', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (p) return p;
  } catch (_) {}
  return process.execPath;
})();

const serverDir = path.resolve(__dirname, '..', '..');
const projectDir = path.resolve(serverDir, '..');
const clientDir = path.resolve(projectDir, 'client');

function runNodeScript(scriptPath, args, cwd) {
  const result = spawnSync(NODE_BIN, [scriptPath, ...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status === 0;
}

function resolveNpmCli() {
  const candidates = [];

  if (process.env.npm_execpath && process.env.npm_execpath.trim()) {
    candidates.push(process.env.npm_execpath.trim());
  }

  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push('/usr/lib/node_modules/npm/bin/npm-cli.js');
  candidates.push('/usr/local/lib/node_modules/npm/bin/npm-cli.js');

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

function ensureClientDependencies() {
  const tscBin = path.resolve(clientDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const viteBin = path.resolve(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(tscBin) && fs.existsSync(viteBin)) {
    return true;
  }

  const npmCli = resolveNpmCli();
  if (!npmCli) {
    console.error('[Client Build] npm CLI not found.');
    console.error('[Client Build] Install dependencies manually in client/ and retry.');
    return false;
  }

  console.log('[Client Build] Installing client dependencies via npm CLI...');
  return runNodeScript(npmCli, ['install'], clientDir);
}

function buildClient() {
  const tscBin = path.resolve(clientDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const viteBin = path.resolve(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');

  if (!fs.existsSync(tscBin) || !fs.existsSync(viteBin)) {
    console.error('[Client Build] Build tools not found after install.');
    return false;
  }

  console.log('[Client Build] Step 1/2: TypeScript compile');
  if (!runNodeScript(tscBin, [], clientDir)) {
    console.error('[Client Build] TypeScript compile failed.');
    return false;
  }

  console.log('[Client Build] Step 2/2: Vite build');
  if (!runNodeScript(viteBin, ['build'], clientDir)) {
    console.error('[Client Build] Vite build failed.');
    return false;
  }

  return true;
}

function main() {
  if (!fs.existsSync(clientDir)) {
    console.error(`[Client Build] client directory not found: ${clientDir}`);
    process.exit(1);
  }

  console.log(`[Client Build] Node: ${NODE_BIN}`);
  console.log(`[Client Build] Client dir: ${clientDir}`);

  if (!ensureClientDependencies()) {
    process.exit(1);
  }

  const ok = buildClient();
  if (!ok) {
    process.exit(1);
  }

  console.log('[Client Build] Done.');
}

main();
