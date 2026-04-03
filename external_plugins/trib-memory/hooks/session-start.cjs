'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);
if (_event.kind && _event.kind !== 'interactive') process.exit(0);

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const CONTEXT_FILE = path.join(DATA_DIR, 'history', 'context.md');
const PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port');

let contextContent = '';
try {
  contextContent = fs.readFileSync(CONTEXT_FILE, 'utf8').trim();
} catch {}

function respond(content) {
  if (!content) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: content
    }
  }));
}

// Wait for service to be ready (health check), poll every 1s, max 30s
function waitForService(cb) {
  const deadline = Date.now() + 30000;
  function check() {
    let port;
    try { port = fs.readFileSync(PORT_FILE, 'utf8').trim(); } catch {}
    if (!port) {
      if (Date.now() >= deadline) return cb(null);
      return setTimeout(check, 1000);
    }
    // HTTP health check — service actually responding?
    const req = http.get(`http://localhost:${port}/health`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) return cb(port);
      if (Date.now() >= deadline) return cb(null);
      setTimeout(check, 1000);
    });
    req.on('error', () => {
      if (Date.now() >= deadline) return cb(null);
      setTimeout(check, 1000);
    });
    req.on('timeout', () => {
      req.destroy();
      if (Date.now() >= deadline) return cb(null);
      setTimeout(check, 1000);
    });
  }
  check();
}

waitForService((port) => {
  if (!port) {
    respond(contextContent);
    return;
  }

  const req = http.get(`http://localhost:${port}/recent`, { timeout: 5000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        const recent = data.recent || '';
        const merged = [contextContent, recent].filter(Boolean).join('\n\n');
        respond(merged);
      } catch {
        respond(contextContent);
      }
    });
  });
  req.on('error', () => respond(contextContent));
  req.on('timeout', () => { req.destroy(); respond(contextContent); });
});
