const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = path.join(os.tmpdir(), 'trib-channels');
try { fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');

// Read the hook event from stdin and ignore sidechain stop events only.
let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {}

if (input) {
  try {
    const event = JSON.parse(input);
    // teamName may also be present on the main session in team mode,
    // so only sidechains should be filtered out here.
    if (event.isSidechain) process.exit(0);
  } catch {}
}

function readActiveInstance() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_INSTANCE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

try {
  const active = readActiveInstance();
  if (!active || !active.turnEndFile) process.exit(0);
  const turnEndFile = active.turnEndFile;
  fs.mkdirSync(path.dirname(turnEndFile), { recursive: true });
  fs.writeFileSync(turnEndFile, String(Date.now()));
} catch {}
