'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const serverDir = path.resolve(__dirname, '..', '..');
const projectDir = path.resolve(serverDir, '..');
const clientDir = path.resolve(projectDir, 'client');

function runNodeScript(scriptPath, args, cwd) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
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
  if (!runNodeScript(tscBin, [], clientDir)) return false;

  console.log('[Client Build] Step 2/2: Vite build');
  if (!runNodeScript(viteBin, ['build'], clientDir)) return false;

  return true;
}

function main() {
  if (!fs.existsSync(clientDir)) {
    console.error(`[Client Build] client directory not found: ${clientDir}`);
    process.exit(1);
  }

  console.log(`[Client Build] Node: ${process.execPath}`);
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
