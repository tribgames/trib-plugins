#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { copyFile, access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
const pluginData = process.env.CLAUDE_PLUGIN_DATA

if (!pluginRoot) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_ROOT is required\n')
  process.exit(1)
}

if (!pluginData) {
  process.stderr.write('run-mcp: CLAUDE_PLUGIN_DATA is required\n')
  process.exit(1)
}

const manifestPath = join(pluginRoot, 'package.json')
const lockfilePath = join(pluginRoot, 'package-lock.json')
const dataManifestPath = join(pluginData, 'package.json')
const dataLockfilePath = join(pluginData, 'package-lock.json')
const dataNodeModules = join(pluginData, 'node_modules')
const tsxBin = join(
  dataNodeModules,
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)
const logPath = join(pluginData, 'run-mcp.log')

function log(message) {
  writeFileSync(
    logPath,
    `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`,
    { flag: 'a' },
  )
}

function fileContents(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function runInstall(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginData,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function syncDependenciesIfNeeded() {
  mkdirSync(pluginData, { recursive: true })
  log(`invoked root=${pluginRoot} data=${pluginData}`)

  let needsInstall = false
  if (fileContents(manifestPath) !== fileContents(dataManifestPath)) {
    needsInstall = true
  }
  if (!(await isExecutable(tsxBin))) {
    needsInstall = true
  }

  if (!needsInstall) {
    return
  }

  log('dependency sync required')
  rmSync(dataNodeModules, { recursive: true, force: true })
  await copyFile(manifestPath, dataManifestPath)

  if (fileContents(lockfilePath) != null) {
    await copyFile(lockfilePath, dataLockfilePath)
    runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--silent'])
    log('npm ci completed')
    return
  }

  runInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'])
  log('npm install completed')
}

await syncDependenciesIfNeeded()

const serverTs = join(pluginRoot, 'server.ts')
const serverJs = join(pluginData, 'server.bundle.mjs')
const esbuildBin = join(dataNodeModules, '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
const spawnEnv = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH
    ? `${dataNodeModules}${process.platform === 'win32' ? ';' : ':'}${process.env.NODE_PATH}`
    : dataNodeModules,
}

// Pre-build TypeScript → JS bundle for fast MCP handshake (~40ms vs ~500ms with tsx)
function buildBundle() {
  try {
    const srcStat = statSync(serverTs)
    try {
      const bundleStat = statSync(serverJs)
      if (bundleStat.mtimeMs >= srcStat.mtimeMs) return true // bundle is fresh
    } catch { /* bundle doesn't exist yet */ }
    log('building server bundle...')
    const result = spawnSync(esbuildBin, [
      serverTs, '--bundle', '--platform=node', '--format=esm',
      `--outfile=${serverJs}`, '--packages=external',
    ], { cwd: pluginRoot, stdio: 'pipe', timeout: 15000 })
    if (result.status === 0) {
      log('bundle built successfully')
      return true
    }
    log(`bundle build failed: ${result.stderr?.toString().slice(0, 200)}`)
    return false
  } catch (e) {
    log(`bundle build error: ${e.message}`)
    return false
  }
}

const hasBundled = buildBundle()

const child = hasBundled
  ? (() => {
      log(`exec node ${serverJs} (bundled)`)
      return spawn('node', [serverJs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()
  : process.platform === 'win32'
  ? (() => {
      const tsxCliPath = join(dataNodeModules, 'tsx', 'dist', 'cli.mjs')
      log(`exec node ${tsxCliPath} ${serverTs} (tsx fallback)`)
      return spawn('node', [tsxCliPath, serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()
  : (() => {
      log(`exec ${tsxBin} ${serverTs} (tsx fallback)`)
      return spawn(tsxBin, [serverTs], { cwd: pluginRoot, stdio: 'inherit', env: spawnEnv })
    })()

let shuttingDown = false
function relayShutdown(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  log(`relay shutdown signal=${signal}`)

  try {
    child.kill(signal)
  } catch {
    process.exit(0)
    return
  }

  setTimeout(() => {
    try {
      child.kill('SIGKILL')
      log('child forced to SIGKILL after shutdown timeout')
    } catch { /* ignore */ }
  }, 3000).unref()
}

child.on('exit', (code, signal) => {
  log(`child exit code=${code ?? 'null'} signal=${signal ?? 'null'}`)
  process.exit(code ?? 0)
})
child.on('error', err => {
  log(`spawn failed: ${err}`)
  process.stderr.write(`run-mcp: spawn failed: ${err}\n`)
  process.exit(1)
})

process.on('SIGTERM', () => relayShutdown('SIGTERM'))
process.on('SIGINT', () => relayShutdown(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'))
process.on('SIGHUP', () => relayShutdown('SIGTERM'))
process.on('disconnect', () => relayShutdown('SIGTERM'))
