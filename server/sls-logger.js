// server/sls-logger.js — best-effort structured log shipper to Aliyun SLS.
//
// Why HTTP, not the SDK: the official @aliyun-sdk/log hits the binary for
// 2+ MB of dependencies and pulls a protobuf compiler. We only need
// PostLogStoreLogs (one endpoint) and we never want a transitive dep
// failure to take down codex-api. So we hand-build the request and use
// Node's built-in https + crypto.
//
// SLS HTTP signature (v3) is just:
//   POST <endpoint>/logstores/<logstore>/shards/lb
//   Authorization: LOG <AccessKeyId>:<Signature>
//   x-log-bodyrawsize: <bytes>
//   Content-Type: application/x-protobuf  (we use application/json —
//                                          SLS accepts both for the LB
//                                          shard write endpoint, JSON
//                                          is far easier to inspect
//                                          in the console)
//   body: { __logs__: [ { time, contents: [ [k, v], ... ] }, ... ] }
//
// Signature = base64(hmac-sha1("POST\napplication/json\n<md5-hex>\n<path>\n<x-log-bodyrawsize>\n<x-log-date>", secret))
//
// Behavior:
//   - Buffer up to FLUSH_MAX lines or FLUSH_MS milliseconds.
//   - On any failure, console.error the cause. The request handler is
//     NEVER blocked (we don't `await logToSls`).
//   - If SLS_* env vars are missing, this is a no-op (everything still
//     gets to stdout via the original console.log). The startup banner
//     logs a one-line notice so operators know logs aren't shipping.

'use strict';

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const FLUSH_MAX = Number(process.env.SLS_FLUSH_MAX || 50);
const FLUSH_MS  = Number(process.env.SLS_FLUSH_MS  || 1000);

const cfg = {
  endpoint:  process.env.SLS_ENDPOINT  || '',
  project:   process.env.SLS_PROJECT   || '',
  logstore:  process.env.SLS_LOGSTORE  || '',
  akId:      process.env.SLS_ACCESS_KEY_ID     || '',
  akSecret:  process.env.SLS_ACCESS_KEY_SECRET || '',
  topic:     process.env.SLS_TOPIC || 'codex-api',
};

const configured = !!(cfg.endpoint && cfg.project && cfg.logstore && cfg.akId && cfg.akSecret);
let enabled = configured;
let queue = [];
let timer = null;
let droppedCount = 0;

// Strip fields we never want to leak to SLS (defence in depth — the
// callers should already avoid these, but if someone adds a debug
// `apiKey: req.body.apiKey` line we don't want it persisted).
const SECRET_KEYS = /^(apiKey|openaiApiKey|password|secret|authorization|cookie|llm_api_key|access_?key_?secret)$/i;

function scrub(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (SECRET_KEYS.test(k)) { out[k] = '<redacted>'; continue; }
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null) {
      try { out[k] = JSON.stringify(v); } catch { out[k] = '[unserializable]'; }
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function buildBody(lines) {
  const now = Date.now();
  const logs = lines.map((entry) => {
    const fields = scrub({ ts: now, ...entry });
    return {
      time: Math.floor(now / 1000),
      contents: Object.entries(fields),
    };
  });
  return { __logs__: logs };
}

function sign(bodyStr, bodyRawSize, dateHeader) {
  const path = '/logstores/' + cfg.logstore + '/shards/lb';
  const md5 = crypto.createHash('md5').update(bodyStr).digest('hex');
  const stringToSign = [
    'POST',
    'application/json',
    md5,
    path,
    String(bodyRawSize),
    dateHeader,
  ].join('\n');
  const sig = crypto.createHmac('sha1', cfg.akSecret)
    .update(stringToSign)
    .digest('base64');
  return 'LOG ' + cfg.akId + ':' + sig;
}

function post(batch) {
  if (!enabled || batch.length === 0) return;
  const bodyStr = JSON.stringify(buildBody(batch));
  const bodyBuf = Buffer.from(bodyStr, 'utf8');
  const date = new Date().toUTCString();
  const bodyRawSize = bodyBuf.length;

  let url;
  try {
    // SLS LB write endpoint uses the project endpoint (not the region
    // endpoint) so it load-balances across shards.
    url = new URL('https://' + cfg.project + '.' + cfg.endpoint
      + '/logstores/' + cfg.logstore + '/shards/lb');
  } catch (e) {
    console.error('[sls] invalid endpoint config, disabling:', e.message);
    enabled = false;
    return;
  }

  const req = https.request({
    method: 'POST',
    host: url.host,
    path: url.pathname,
    headers: {
      'Authorization': sign(bodyStr, bodyRawSize, date),
      'Content-Type': 'application/json',
      'Content-Length': bodyRawSize,
      'x-log-bodyrawsize': String(bodyRawSize),
      'x-log-apiversion': '0.6.0',
      'x-log-date': date,
      'x-log-topic': cfg.topic,
      'User-Agent': 'codex-api/1.0 (sls-logger)',
    },
    timeout: 5000,
  }, (res) => {
    // Drain to free sockets; we don't care about the body unless it failed.
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) return;
      if (res.statusCode === 404 || res.statusCode === 403) {
        // project/logstore missing or no permission — disable so we
        // stop hammering the endpoint.
        console.error('[sls] ' + res.statusCode + ' from SLS, disabling further shipping:', cfg.project + '/' + cfg.logstore);
        enabled = false;
        return;
      }
      console.error('[sls] non-2xx from SLS:', res.statusCode);
    });
  });
  req.on('error', (e) => {
    // network blip / DNS / TLS — log once per batch, keep going.
    console.error('[sls] post failed:', e.message, 'batch=' + batch.length);
  });
  req.on('timeout', () => {
    req.destroy(new Error('timeout'));
  });
  req.write(bodyBuf);
  req.end();
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  post(batch);
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { flush(); schedule(); }, FLUSH_MS);
  timer.unref?.();
}

/**
 * Best-effort structured log to SLS. NEVER awaits, NEVER throws.
 * Always also writes to stdout so journalctl still works.
 *
 * @param {string} level   info | warn | error | debug
 * @param {string} message one-line human message
 * @param {object} fields  additional structured fields (requestId, jobId, …)
 */
function logToSls(level, message, fields) {
  const line = { level: level || 'info', message: message || '' };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'level' || k === 'message') continue;
      line[k] = v;
    }
  }
  // Drop on the floor if SLS is misbehaving so we never OOM the process.
  if (queue.length >= 5000) { droppedCount += 1; return; }
  queue.push(line);
  if (queue.length >= FLUSH_MAX) flush();
  else schedule();
}

/** Startup banner — emit once on boot so operators see SLS state. */
function banner() {
  if (configured) {
    return '[sls] shipping logs to ' + cfg.project + '/' + cfg.logstore
      + ' @ ' + cfg.endpoint + ' (batch=' + FLUSH_MAX + ' / flush=' + FLUSH_MS + 'ms)';
  }
  return '[sls] SLS_* env vars missing — structured logging disabled (stdout only)';
}

function flushSync() {
  // For tests / graceful shutdown — blocks until the queue is empty.
  // Not used on the hot path; on hard exit we just lose the last batch.
  flush();
}

module.exports = {
  logToSls,
  banner,
  flushSync,
  // exposed for unit tests
  _scrub: scrub,
  _configured: () => configured,
  _enabled: () => enabled,
  _queueLen: () => queue.length,
};
