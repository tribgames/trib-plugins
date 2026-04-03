'use strict';

const fs = require('fs');
const path = require('path');

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
const RECENT_FILE = path.join(DATA_DIR, 'history', 'recent.md');

let contextContent = '';
try { contextContent = fs.readFileSync(CONTEXT_FILE, 'utf8').trim(); } catch {}

let recentContent = '';
try { recentContent = fs.readFileSync(RECENT_FILE, 'utf8').trim(); } catch {}

const merged = [contextContent, recentContent].filter(Boolean).join('\n\n');
if (merged) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: merged
    }
  }));
}
