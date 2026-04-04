if (process.env.TRIB_CHANNELS_NO_CONNECT) process.exit(0);
/**
 * trib-channels PermissionRequest hook
 * 1. Send Discord message with approve/deny buttons
 * 2. Poll runtime/perm-{instance}-{uuid}.result for decision
 * 3. Return JSON decision to stdout
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEBUG = process.env.TRIB_CHANNELS_DEBUG === '1';

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
if (!DATA_DIR) process.exit(0);

const RUNTIME_ROOT = path.join(os.tmpdir(), 'trib-channels');
try { fs.mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json');

// Skip when channels are not enabled in this session.
const SESSION_SIGNAL_FILE = path.join(RUNTIME_ROOT, 'session-signal.json');
try {
  const sig = JSON.parse(fs.readFileSync(SESSION_SIGNAL_FILE, 'utf8'));
  if (sig.channelsEnabled === false) process.exit(0);
} catch {}

const POLL_INTERVAL = 2000;
const TIMEOUT = 900000; // 15 minutes
const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readActiveInstance() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_INSTANCE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'discord.com', path: apiPath, method: method, headers: headers },
      res => { let out = ''; res.on('data', d => { out += d; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({}); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cleanupStaleFiles() {
  try {
    const files = fs.readdirSync(RUNTIME_ROOT);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith('perm-') && f.endsWith('.pending')) {
        const fp = path.join(RUNTIME_ROOT, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > STALE_THRESHOLD) {
            fs.unlinkSync(fp);
            // Also remove matching result file
            const resultFile = fp.replace('.pending', '.result');
            try { fs.unlinkSync(resultFile); } catch {}
          }
        } catch {}
      }
    }
  } catch {}
}

function buildContent(toolName, toolInput) {
  let detail = '';
  if (toolName === 'Bash' || (toolName && toolName.includes('Bash'))) {
    detail = (toolInput.command || '').substring(0, 800);
  } else if (toolName === 'Write') {
    detail = toolInput.file_path || '';
  } else if (toolName === 'Edit') {
    detail = (toolInput.file_path || '') + '\n' + (toolInput.old_string || '').substring(0, 200);
  } else {
    detail = JSON.stringify(toolInput).substring(0, 800);
  }

  let msg = '🔐 **Permission Request**\nTool: `' + toolName + '`';
  if (detail) msg += '\n```\n' + detail + '\n```';
  return msg;
}

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);

    const configPath = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(configPath)) process.exit(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const token = config.discord && config.discord.token;
    if (!token) process.exit(0);
    const access = config.access || null;
    const mainLabel = config.channelsConfig && config.channelsConfig.main;
    const channels = config.channelsConfig && config.channelsConfig.channels;
    const channelId = mainLabel && channels && channels[mainLabel] && channels[mainLabel].id;
    if (!channelId) process.exit(0);

    // Clean up stale pending files before creating a new request.
    cleanupStaleFiles();

    const uuid = crypto.randomBytes(16).toString('hex');
    const active = readActiveInstance();
    if (!active || !active.instanceId) process.exit(0);
    const instanceId = sanitize(active.instanceId);
    const pendingFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.pending`);
    const resultFile = path.join(RUNTIME_ROOT, `perm-${instanceId}-${uuid}.result`);

    const toolName = data.tool_name || 'unknown';
    const toolInput = data.tool_input || {};
    const permSuggestions = data.permission_suggestions || [];

    // Send the approval message with Discord buttons.
    const content = buildContent(toolName, toolInput);
    const body = {
      content: content,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Allow', custom_id: 'perm-' + uuid + '-allow' },
          { type: 2, style: 1, label: 'Session Allow', custom_id: 'perm-' + uuid + '-session' },
          { type: 2, style: 4, label: 'Deny', custom_id: 'perm-' + uuid + '-deny' }
        ]
      }]
    };

    if (access && access.allowFrom && access.allowFrom.length > 0) {
      body.content += '\n\nAllowed approvers: ' + access.allowFrom.join(', ');
    }

    const msgResult = await discordApi('POST', '/api/v10/channels/' + channelId + '/messages', token, body);
    const messageId = msgResult.id;

    if (!messageId) {
      // If Discord delivery fails, fall back to the terminal flow.
      process.exit(0);
    }

    // Create the pending marker for the matching result poll.
    fs.writeFileSync(pendingFile, JSON.stringify({ uuid: uuid, messageId: messageId, channelId: channelId, toolName: toolName, createdAt: Date.now() }));

    // SIGTERM handler — PC에서 직접 승인 시 Claude Code가 훅 프로세스를 kill
    // Discord 메시지에서 버튼 제거 + 상태 업데이트
    process.on('SIGTERM', async () => {
      try { fs.unlinkSync(pendingFile); } catch {}
      try { fs.unlinkSync(resultFile); } catch {}
      if (messageId) {
        await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
          content: content + '\n\n↩️ Resolved from terminal.',
          components: []
        }).catch(() => {});
      }
      process.exit(0);
    });

    // Poll for the decision result file.
    const startTime = Date.now();

    const STOP_FLAG = path.join(RUNTIME_ROOT, `stop-${instanceId}.flag`);

    while (Date.now() - startTime < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));

      // Abort immediately when the stop flag is written.
      try {
        if (fs.existsSync(STOP_FLAG)) {
          const ts = parseInt(fs.readFileSync(STOP_FLAG, 'utf8').trim(), 10);
          if (Date.now() - ts < 30000) {
            fs.unlinkSync(STOP_FLAG);
            // Clean up runtime markers.
            try { fs.unlinkSync(pendingFile); } catch {}
            try { fs.unlinkSync(resultFile); } catch {}
            // Update the Discord message to show the interruption.
            if (messageId) {
              await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
                content: content + '\n\n⛔ Operation interrupted.',
                components: []
              });
            }
            // Return a deny + interrupt decision to the hook caller.
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'deny', message: 'User interrupted the operation.', interrupt: true }
              }
            }));
            process.exit(0);
          }
        }
      } catch {}

      if (fs.existsSync(resultFile)) {
        let decision;
        try {
          const result = fs.readFileSync(resultFile, 'utf8').trim();
          if (DEBUG) process.stderr.write('[perm-hook] result file content: "' + result + '"\n');

          if (result === 'allow') {
            decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
          } else if (result === 'session') {
            // Reuse permission suggestions when available; otherwise allow the full tool for the session.
            const perms = permSuggestions.length > 0
              ? permSuggestions.map(s => ({ ...s, destination: 'session' }))
              : [{ type: 'addRules', rules: [{ toolName: toolName }], behavior: 'allow', destination: 'session' }];
            decision = {
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                  behavior: 'allow',
                  updatedPermissions: perms
                }
              }
            };
          } else {
            decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Discord' } } };
          }
        } catch {
          decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Failed to read result' } } };
        }

        // Clean up runtime markers.
        try { fs.unlinkSync(pendingFile); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}

        if (DEBUG) process.stderr.write('[perm-hook] decision: ' + JSON.stringify(decision) + '\n');
        process.stdout.write(JSON.stringify(decision));
        process.exit(0);
      }
    }

    // Timeout — update the Discord message and deny the request.
    if (messageId) {
      await discordApi('PATCH', '/api/v10/channels/' + channelId + '/messages/' + messageId, token, {
        content: content + '\n\n\u26A0\uFE0F Auto-denied due to timeout.',
        components: []
      });
    }

    // Clean up runtime markers.
    try { fs.unlinkSync(pendingFile); } catch {}
    try { fs.unlinkSync(resultFile); } catch {}

    const denyDecision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Timeout' } } };
    process.stdout.write(JSON.stringify(denyDecision));
    process.exit(0);
  } catch {
    // Fail closed and let Claude fall back to terminal approval.
    process.exit(0);
  }
});
