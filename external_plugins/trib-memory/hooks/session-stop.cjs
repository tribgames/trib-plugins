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

// Skip for sidechains and agents
if (_event.isSidechain) process.exit(0);
if (_event.agentId) process.exit(0);

const PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port');
const SESSION_FILE = path.join(os.homedir(), 'Project', 'SESSION-LAST.md');

let port;
try {
  port = fs.readFileSync(PORT_FILE, 'utf8').trim();
} catch {
  process.exit(0);
}

// Call /recent to get last session turns + key conversations
const req = http.get(`http://localhost:${port}/recent`, { timeout: 5000 }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      const content = data.recent || '';
      if (content.length > 30) {
        fs.writeFileSync(SESSION_FILE, content);
      }
    } catch {}
  });
});
req.on('error', () => {});
req.on('timeout', () => { req.destroy(); });
