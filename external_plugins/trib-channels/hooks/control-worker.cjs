const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const instanceId = process.argv[2];
if (!instanceId) process.exit(1);

const runtimeRoot = path.join(os.tmpdir(), 'trib-channels');
try { fs.mkdirSync(runtimeRoot, { recursive: true }); } catch {}
const controlFile = path.join(runtimeRoot, `control-${instanceId}.json`);
const responseFile = path.join(runtimeRoot, `control-${instanceId}.response.json`);

let lastHandledId = '';

function escapeForTmux(text) {
  return String(text).replace(/(["\\$`])/g, '\\$1');
}

function findTmuxSession() {
  const sessions = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  return sessions.find(s => s.includes('claude')) || sessions[0] || null;
}

function tryTmux(command) {
  try {
    const target = findTmuxSession();
    if (!target) return null;
    if (command.type === 'interrupt') {
      execSync(`tmux send-keys -t ${target} Escape`);
    } else {
      execSync(`tmux send-keys -t ${target} "${escapeForTmux(command.text)}" Enter`);
    }
    return { ok: true, mode: 'tmux', message: `tmux:${target}` };
  } catch {
    return null;
  }
}

function findWslTmuxSession() {
  const sessions = execFileSync('wsl.exe', ['tmux', 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  return sessions.find(s => s.includes('claude')) || sessions[0] || null;
}

function tryWslTmux(command) {
  if (process.platform !== 'win32') return null;
  try {
    const target = findWslTmuxSession();
    if (!target) return null;
    if (command.type === 'interrupt') {
      execFileSync('wsl.exe', ['tmux', 'send-keys', '-t', target, 'Escape'], { stdio: 'ignore' });
    } else {
      execFileSync('wsl.exe', ['tmux', 'send-keys', '-t', target, command.text, 'Enter'], { stdio: 'ignore' });
    }
    return { ok: true, mode: 'tmux', message: `wsl-tmux:${target}` };
  } catch {
    return null;
  }
}

function getPowerShellBinary() {
  for (const candidate of ['powershell.exe', 'pwsh']) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], { stdio: 'ignore' });
      return candidate;
    } catch {}
  }
  return null;
}

function tryPowerShell(command) {
  if (process.platform !== 'win32') return null;
  const ps = getPowerShellBinary();
  if (!ps) return null;
  try {
    if (command.type === 'interrupt') {
      const script = [
        '$wshell = New-Object -ComObject WScript.Shell',
        'if (-not $wshell.AppActivate("claude")) { exit 2 }',
        'Start-Sleep -Milliseconds 100',
        '$wshell.SendKeys("{ESC}")',
      ].join('; ');
      execFileSync(ps, ['-NoProfile', '-Command', script], { stdio: 'ignore' });
      return { ok: true, mode: 'powershell', message: 'powershell:escape' };
    }

    const clipboardPath = path.join(os.tmpdir(), 'trib-channels-control-clipboard.txt');
    fs.writeFileSync(clipboardPath, command.text, 'utf8');
    const script = [
      `$text = Get-Content -LiteralPath '${clipboardPath.replace(/'/g, "''")}' -Raw`,
      'Set-Clipboard -Value $text',
      '$wshell = New-Object -ComObject WScript.Shell',
      'if (-not $wshell.AppActivate("claude")) { exit 2 }',
      'Start-Sleep -Milliseconds 100',
      '$wshell.SendKeys("^v")',
      'Start-Sleep -Milliseconds 50',
      '$wshell.SendKeys("~")',
    ].join('; ');
    execFileSync(ps, ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    return { ok: true, mode: 'powershell', message: 'powershell:sendkeys' };
  } catch {
    return null;
  }
}

function executeCommand(command) {
  const tmux = tryTmux(command);
  if (tmux) return tmux;

  const wslTmux = tryWslTmux(command);
  if (wslTmux) return wslTmux;

  const ps = tryPowerShell(command);
  if (ps) return ps;

  return {
    ok: false,
    mode: 'unsupported',
    message: process.platform === 'win32' ? 'Windows session control unavailable' : 'tmux not found',
  };
}

function tick() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
  } catch {
    return;
  }
  if (!payload || !payload.id || payload.id === lastHandledId || !payload.command) return;
  lastHandledId = payload.id;
  const result = executeCommand(payload.command);
  try {
    fs.writeFileSync(responseFile, JSON.stringify({ id: payload.id, ...result, respondedAt: Date.now() }));
  } catch {}
}

setInterval(tick, 200);

// Orphan guard: exit if parent process dies
const ppid = process.ppid;
setInterval(() => {
  try { process.kill(ppid, 0); } catch { process.exit(0); }
}, 2000);
