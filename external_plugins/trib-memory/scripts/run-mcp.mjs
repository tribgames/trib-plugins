#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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

function runInstall(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginData,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  })

  if (result.status !== 0) {
    log(`npm install failed with status ${result.status}`)
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

const serverMjs = join(pluginRoot, 'services', 'memory-service.mjs')
const spawnEnv = {
  ...process.env,
  NODE_PATH: process.env.NODE_PATH
    ? `${dataNodeModules}${process.platform === 'win32' ? ';' : ':'}${process.env.NODE_PATH}`
    : dataNodeModules,
}

log(`exec node --no-warnings ${serverMjs}`)
const child = spawn('node', ['--no-warnings', serverMjs], {
  cwd: pluginRoot,
  stdio: 'inherit',
  env: spawnEnv,
})

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
