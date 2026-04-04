'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const HINTS_PORT_FILE = path.join(os.tmpdir(), 'trib-memory', 'memory-port');

function main() {
  let input = '';
  let responded = false;
  function respond(obj) {
    if (responded) return;
    responded = true;
    process.stdout.write(JSON.stringify(obj));
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input);
      const message = typeof payload.prompt === 'string' ? payload.prompt : '';
      if (!message || message.length < 3) {
        respond({});
        return;
      }
      fetchHints(message, (hints) => {
        if (!hints || !hints.trim() || hints.trim() === '<memory-context>\n</memory-context>') {
          respond({});
          return;
        }
        respond({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: hints
          },
          suppressOutput: true
        });
      });
    } catch (e) {
      respond({});
    }
  });
}

function fetchHints(query, cb) {
  let port;
  try {
    port = fs.readFileSync(HINTS_PORT_FILE, 'utf8').trim();
  } catch {
    cb(null);
    return;
  }

  let done = false;
  function once(val) {
    if (done) return;
    done = true;
    cb(val);
  }

  const url = `http://localhost:${port}/hints?q=${encodeURIComponent(query)}`;
  const req = http.get(url, { timeout: 8000 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        once(data.hints || null);
      } catch {
        once(null);
      }
    });
  });
  req.on('error', () => once(null));
  req.on('timeout', () => { req.destroy(); once(null); });
}

main();
