// Roku ECP web client + safe 3-integer parser.
// - Parses up to 3 valid signed 32-bit integers from input (skips invalid tokens).
// - Calls Roku ECP endpoints: POST /keypress/{key}, /keypress/Lit_x, POST /launch/{appid},
//   GET /query/device-info, /query/apps, /query/active-app.
// - Shows logs and warnings. Handles network/fetch errors and timeouts.

document.addEventListener('DOMContentLoaded', () => {
  const rokuIpEl = document.getElementById('rokuIp');
  const inputEl = document.getElementById('input');
  const parseBtn = document.getElementById('parseBtn');
  const sendParsedBtn = document.getElementById('sendParsedBtn');
  const sendParsedWithSubmitBtn = document.getElementById('sendParsedWithSubmitBtn');
  const clearBtn = document.getElementById('clearBtn');
  const summary = document.getElementById('summary');
  const warnings = document.getElementById('warnings');
  const logEl = document.getElementById('log');

  const launchBtn = document.getElementById('launchBtn');
  const appIdEl = document.getElementById('appId');
  const sendKeyBtn = document.getElementById('sendKeyBtn');
  const remoteKeyEl = document.getElementById('remoteKey');
  const sendLitBtn = document.getElementById('sendLitBtn');
  const litCharEl = document.getElementById('litChar');

  function log(...args) {
    const now = new Date().toISOString().slice(11, 23);
    logEl.textContent = `${now}  ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n` + logEl.textContent;
  }

  function isValidSigned32(n) {
    return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  }

  function parseTokens(text, limit = 3) {
    const raw = text.split(/[,\s;]+/);
    const values = [];
    const bad = [];
    for (const tok of raw) {
      if (!tok) continue;
      if (!/^[+-]?\d+$/.test(tok)) {
        bad.push({ token: tok, reason: 'not an integer token' });
        continue;
      }
      const n = Number(tok);
      if (!isValidSigned32(n)) {
        bad.push({ token: tok, reason: 'out of 32-bit integer range' });
        continue;
      }
      values.push(n);
      if (values.length >= limit) break;
    }
    return { values, bad };
  }

  function renderParse() {
    const text = inputEl.value;
    if (!text.trim()) {
      summary.textContent = 'No integers read.';
      warnings.innerHTML = '';
      return;
    }
    const { values, bad } = parseTokens(text, 3);
    if (values.length === 0) {
      summary.textContent = 'No valid integers found.';
    } else {
      summary.innerHTML = `Read ${values.length} integer(s): <strong>${values.join(', ')}</strong>`;
    }

    const parts = [];
    if (bad.length > 0) {
      parts.push(`<div class="card"><strong>Warnings</strong><ul>${bad.map(b => `<li><code>${escapeHtml(b.token)}</code>: ${escapeHtml(b.reason)}</li>`).join('')}</ul></div>`);
    } else {
      parts.push(`<div class="card">No warnings.</div>`);
    }

    const totalTokens = text.split(/[,\s;]+/).filter(t => t).length;
    if (totalTokens > 3 && values.length === 3) {
      parts.push(`<div class="card">Note: parsed the first 3 valid integers and ignored the rest.</div>`);
    }

    warnings.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return (s+'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // sendRequest to Roku ECP with timeout and simple error handling
  async function sendRequest(path, method = 'POST', opts = {}) {
    const ip = (rokuIpEl.value || '').trim();
    if (!ip) {
      throw new Error('Roku IP is required');
    }
    const url = `http://${ip}:8060${path}`;
    const controller = new AbortController();
    const timeoutMs = opts.timeout ?? 5000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: opts.headers || {},
    };
    if (opts.body != null) {
      fetchOpts.body = opts.body;
    }
    try {
      log(`REQUEST ${method} ${url} ${opts.body ? '(body)' : ''}`);
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);
      const contentType = res.headers.get('content-type') || '';
      let text = '';
      try {
        text = await res.text();
      } catch (e) {
        text = `<unable to read body: ${e.message}>`;
      }
      log(`RESPONSE ${res.status} ${res.statusText} — ${contentType}`);
      return { ok: res.ok, status: res.status, statusText: res.statusText, text, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        log(`ERROR: request timed out (${timeoutMs}ms)`);
        throw new Error('Request timed out');
      }
      // fetch throws TypeError on network errors (including CORS preflight failures)
      log(`ERROR: ${err && err.message ? err.message : String(err)}`);
      throw err;
    }
  }

  // high-level ECP helpers
  async function sendKey(key) {
    // key like "Home" or "Lit_a" or "Select"
    return sendRequest(`/keypress/${encodeURIComponent(key)}`, 'POST');
  }

  async function launchApp(appId, params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
    return sendRequest(`/launch/${encodeURIComponent(appId)}${qs}`, 'POST');
  }

  async function query(path) {
    return sendRequest(`/query/${path}`, 'GET');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // send parsed integers as literal characters (digits with optional sign)
  async function sendParsedIntegersAsChars(pressSelectAfterEach = false) {
    const { values } = parseTokens(inputEl.value, 3);
    if (values.length === 0) {
      log('No parsed integers to send.');
      return;
    }
    log(`Will send ${values.length} integer(s) to Roku as literal characters.`);
    try {
      for (let i = 0; i < values.length; ++i) {
        const s = String(values[i]);
        for (const ch of s) {
          // send as Lit_<char>
          await sendKey(`Lit_${ch}`);
          await sleep(120); // spacing to mimic typing
        }
        if (pressSelectAfterEach) {
          await sendKey('Select');
          await sleep(120);
        }
      }
      log('Finished sending parsed integers.');
    } catch (err) {
      log('Send failed: ' + (err && err.message ? err.message : String(err)));
      // If this is a CORS/network error, present helpful hint
      if (err instanceof TypeError) {
        log('Network/CORS error — your browser may have blocked the request. Try a local proxy or run the page from a server on the same network.');
      }
    }
  }

  // wire up UI
  parseBtn.addEventListener('click', renderParse);
  clearBtn.addEventListener('click', () => {
    inputEl.value = '';
    renderParse();
    inputEl.focus();
  });

  sendParsedBtn.addEventListener('click', () => {
    sendParsedIntegersAsChars(false);
  });
  sendParsedWithSubmitBtn.addEventListener('click', () => {
    sendParsedIntegersAsChars(true);
  });

  sendKeyBtn.addEventListener('click', async () => {
    const key = remoteKeyEl.value.trim();
    if (!key) return;
    try {
      const res = await sendKey(key);
      log(`Key ${key} sent — status ${res.status}`);
      if (res.text) log(res.text);
    } catch (err) {
      log('Failed to send key: ' + err.message);
    }
  });

  sendLitBtn.addEventListener('click', async () => {
    const ch = litCharEl.value;
    if (!ch) return;
    try {
      const res = await sendKey(`Lit_${ch}`);
      log(`Lit_${ch} sent — status ${res.status}`);
      if (res.text) log(res.text);
    } catch (err) {
      log('Failed to send lit char: ' + err.message);
    }
  });

  launchBtn.addEventListener('click', async () => {
    const appId = appIdEl.value.trim();
    if (!appId) {
      log('App ID required.');
      return;
    }
    try {
      const res = await launchApp(appId);
      log(`Launch ${appId} — status ${res.status}`);
      if (res.text) log(res.text);
    } catch (err) {
      log('Failed to launch app: ' + err.message);
    }
  });

  document.getElementById('queryDeviceBtn').addEventListener('click', async () => {
    try {
      const res = await query('device-info');
      log('/query/device-info => status ' + res.status);
      log(res.text || '<no body>');
    } catch (err) {
      log('Query failed: ' + err.message);
    }
  });

  document.getElementById('queryAppsBtn').addEventListener('click', async () => {
    try {
      const res = await query('apps');
      log('/query/apps => status ' + res.status);
      log(res.text || '<no body>');
    } catch (err) {
      log('Query failed: ' + err.message);
    }
  });

  document.getElementById('queryActiveAppBtn').addEventListener('click', async () => {
    try {
      const res = await query('active-app');
      log('/query/active-app => status ' + res.status);
      log(res.text || '<no body>');
    } catch (err) {
      log('Query failed: ' + err.message);
    }
  });

  // live parse preview
  let debounce = null;
  inputEl.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(renderParse, 250);
  });

  // initial render
  renderParse();
});