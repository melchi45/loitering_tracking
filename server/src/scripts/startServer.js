'use strict';

const path = require('path');
const { spawn } = require('child_process');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
} catch {
  // Continue with process env when dotenv is unavailable.
}

function resolveRuntimeOs() {
  const override = (process.env.SERVER_RUNTIME_OS || 'auto').trim().toLowerCase();
  if (override === 'windows' || override === 'win') return 'windows';
  if (override === 'linux') return 'linux';
  return process.platform === 'win32' ? 'windows' : 'linux';
}

function resolveNodeExec(runtimeOs) {
  if (process.env.NODE_EXEC && process.env.NODE_EXEC.trim()) {
    return process.env.NODE_EXEC.trim();
  }
  if (runtimeOs === 'windows') {
    return (process.env.NODE_EXEC_WINDOWS || 'node').trim();
  }
  return (process.env.NODE_EXEC_LINUX || '/usr/bin/node').trim();
}

function resolvePythonExec(runtimeOs) {
  if (process.env.PYTHON_EXEC && process.env.PYTHON_EXEC.trim()) {
    return process.env.PYTHON_EXEC.trim();
  }
  if (runtimeOs === 'windows') {
    return (process.env.PYTHON_EXEC_WINDOWS || 'python').trim();
  }
  return (process.env.PYTHON_EXEC_LINUX || '/usr/bin/python3').trim();
}

function getPathEnvKey(envObj) {
  if (Object.prototype.hasOwnProperty.call(envObj, 'Path')) return 'Path';
  return 'PATH';
}

function pushPathEntry(entries, value) {
  if (!value || typeof value !== 'string') return;
  const v = value.trim();
  if (!v) return;
  if (!entries.includes(v)) entries.push(v);
}

function resolveDirFromBinary(value) {
  if (!value || typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  // Absolute/relative executable path: include its parent directory in PATH.
  if (v.includes('\\') || v.includes('/')) return path.dirname(v);
  return '';
}

function resolveByRuntime(runtimeOs, baseKey) {
  const generic = process.env[baseKey];
  if (generic && String(generic).trim()) return String(generic).trim();
  const osKey = runtimeOs === 'windows' ? `${baseKey}_WINDOWS` : `${baseKey}_LINUX`;
  const osVal = process.env[osKey];
  return osVal && String(osVal).trim() ? String(osVal).trim() : '';
}

function main() {
  const runtimeOs = resolveRuntimeOs();
  const nodeExec = resolveNodeExec(runtimeOs);
  const pythonExec = resolvePythonExec(runtimeOs);
  const serverEntry = path.resolve(__dirname, '..', 'index.js');
  const childEnv = { ...process.env };
  const pathKey = getPathEnvKey(childEnv);
  const pathEntries = [];

  // Ensure subprocesses can discover required binaries even in restricted shells.
  pushPathEntry(pathEntries, resolveDirFromBinary(nodeExec));
  pushPathEntry(pathEntries, resolveDirFromBinary(pythonExec));
  pushPathEntry(pathEntries, resolveByRuntime(runtimeOs, 'FFMPEG_BIN_DIR'));
  pushPathEntry(pathEntries, resolveDirFromBinary(resolveByRuntime(runtimeOs, 'YTDLP_BIN')));

  const currentPath = childEnv[pathKey] || childEnv.PATH || childEnv.Path || '';
  childEnv[pathKey] = pathEntries.length ? `${pathEntries.join(path.delimiter)}${path.delimiter}${currentPath}` : currentPath;

  // Keep Python resolution consistent across runtime features (e.g., PyAV sidecar).
  childEnv.PYTHON = pythonExec;
  if (!childEnv.PYAV_PYTHON_BIN || !childEnv.PYAV_PYTHON_BIN.trim()) {
    childEnv.PYAV_PYTHON_BIN = pythonExec;
  }

  const child = spawn(nodeExec, [serverEntry], {
    stdio: 'inherit',
    env: childEnv,
  });

  child.on('error', (err) => {
    console.error(`[Start] Failed to launch server with "${nodeExec}": ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}

main();