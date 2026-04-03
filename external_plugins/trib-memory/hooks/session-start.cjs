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

// Fetch /recent → generate session context → inject with context.md
let port;
try {
  port = fs.readFileSync(PORT_FILE, 'utf8').trim();
} catch {
  respond(contextContent);
  process.exit(0);
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
