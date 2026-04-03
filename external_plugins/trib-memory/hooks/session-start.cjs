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
const SESSION_FILE = path.join(os.homedir(), 'Project', 'SESSION-LAST.md');

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

// Try to generate SESSION-LAST.md from /recent, then inject
let port;
try {
  port = fs.readFileSync(PORT_FILE, 'utf8').trim();
} catch {
  // Service not running — use existing SESSION-LAST.md if available
  let sessionMd = '';
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (content.length > 50) sessionMd = `## Previous Session\n${content.slice(0, 2000)}`;
  } catch {}
  respond([contextContent, sessionMd].filter(Boolean).join('\n\n'));
  process.exit(0);
}

// Fetch fresh /recent → write SESSION-LAST.md → inject
const req = http.get(`http://localhost:${port}/recent`, { timeout: 5000 }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    let sessionMd = '';
    try {
      const data = JSON.parse(body);
      const recent = data.recent || '';
      if (recent.length > 30) {
        fs.writeFileSync(SESSION_FILE, recent);
        sessionMd = `## Previous Session\n${recent.slice(0, 2000)}`;
      }
    } catch {
      // Fallback to existing file
      try {
        const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
        if (content.length > 50) sessionMd = `## Previous Session\n${content.slice(0, 2000)}`;
      } catch {}
    }
    respond([contextContent, sessionMd].filter(Boolean).join('\n\n'));
  });
});
req.on('error', () => {
  let sessionMd = '';
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (content.length > 50) sessionMd = `## Previous Session\n${content.slice(0, 2000)}`;
  } catch {}
  respond([contextContent, sessionMd].filter(Boolean).join('\n\n'));
});
req.on('timeout', () => {
  req.destroy();
  let sessionMd = '';
  try {
    const content = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (content.length > 50) sessionMd = `## Previous Session\n${content.slice(0, 2000)}`;
  } catch {}
  respond([contextContent, sessionMd].filter(Boolean).join('\n\n'));
});
