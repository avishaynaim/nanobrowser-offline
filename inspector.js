'use strict';

// ── State ────────────────────────────────────────────────
let targetTabId = null;
let capturing = false;
let netRequests = [];
let consoleLogs = [];
let wsConnections = [];
let storageItems = [];
let storageType = 'local';
let replHistory = [];
let lastReplResult = null;
let selectedRequests = new Set();
let selectedLogs = new Set();
let selectedWsFrames = [];
let selectedStorItems = new Set();
let chatContext = [];
let chatHistory = [];
let generating = false;
let chatPort = null;
let interceptPort = null;
let intercepting = false;
let pendingIntercept = null;
let blockPatterns = [];
let globalSearchText = '';
let settings = {
  apiUrl: 'http://localhost:11434/v1',
  model: '',
  apiKey: '',
  systemPrompt: 'You are an AI assistant integrated into a browser dev tool. You help developers understand network requests, console errors, API responses, and page behavior. Be concise, technical, and precise.',
};
let expandedRow = null;
let expandedDetailTab = 'response-body';
let expandedWsConn = null;
let pollTimer = null;
let filterText = '';
let filterMethod = '';
let filterType = '';
let filterLevel = '';
let filterConText = '';

// ── Init ─────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  targetTabId = parseInt(params.get('tabId')) || null;
  await loadSettings();
  await tryAutoConfig();
  if (targetTabId) {
    const tab = await chrome.tabs.get(targetTabId).catch(() => null);
    if (tab) document.getElementById('tab-url').textContent = tab.url || 'Unknown tab';
  } else {
    document.getElementById('tab-url').textContent = 'No tab — open from popup';
  }
  setupUI();
}

// ── Settings ─────────────────────────────────────────────
async function loadSettings() {
  const s = await chrome.storage.local.get('inspector-settings');
  if (s['inspector-settings']) Object.assign(settings, s['inspector-settings']);
}
async function saveSettings() {
  await chrome.storage.local.set({ 'inspector-settings': settings });
}
async function tryAutoConfig() {
  if (settings.model) return;
  try {
    const data = await chrome.storage.local.get(['llm-api-keys', 'agent-models']);
    const providers = data['llm-api-keys']?.providers || {};
    const agents = data['agent-models']?.agents || {};
    const navAgent = agents['navigator'];
    if (navAgent?.provider && providers[navAgent.provider]) {
      const p = providers[navAgent.provider];
      settings.apiUrl = p.baseUrl || settings.apiUrl;
      settings.apiKey = p.apiKey || '';
      settings.model = navAgent.modelName || (p.modelNames?.[0] || '');
      await saveSettings();
      document.getElementById('s-nb-hint').textContent =
        `✓ Auto-imported from Nanobrowser: ${settings.model} @ ${settings.apiUrl}`;
    }
  } catch {}
}

// ── UI Setup ─────────────────────────────────────────────
function setupUI() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  document.getElementById('capture-btn').addEventListener('click', toggleCapture);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('dom-btn').addEventListener('click', attachDom);
  document.getElementById('screenshot-btn').addEventListener('click', takeScreenshot);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('intercept-btn').addEventListener('click', toggleIntercept);
  document.getElementById('block-btn').addEventListener('click', openBlockModal);

  // Export dropdown
  const exportBtn = document.getElementById('export-btn');
  const exportMenu = document.getElementById('export-menu');
  exportBtn.addEventListener('click', e => { e.stopPropagation(); exportMenu.classList.toggle('open'); });
  document.addEventListener('click', () => exportMenu.classList.remove('open'));
  document.getElementById('export-har').addEventListener('click', () => { exportHAR(); exportMenu.classList.remove('open'); });
  document.getElementById('export-json').addEventListener('click', () => { exportJSON(); exportMenu.classList.remove('open'); });

  // Settings modal
  document.getElementById('s-cancel').addEventListener('click', closeSettings);
  document.getElementById('s-save').addEventListener('click', saveSettingsFromForm);
  document.getElementById('settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') closeSettings(); });

  // Block modal
  document.getElementById('block-cancel').addEventListener('click', () => closeModal('block-modal'));
  document.getElementById('block-apply').addEventListener('click', applyBlocking);
  document.getElementById('block-add-btn').addEventListener('click', addBlockPattern);
  document.getElementById('block-input').addEventListener('keydown', e => { if (e.key === 'Enter') addBlockPattern(); });
  document.getElementById('block-modal').addEventListener('click', e => { if (e.target.id === 'block-modal') closeModal('block-modal'); });

  // Screenshot modal
  document.getElementById('screenshot-close').addEventListener('click', () => closeModal('screenshot-modal'));
  document.getElementById('screenshot-attach').addEventListener('click', attachScreenshot);
  document.getElementById('screenshot-modal').addEventListener('click', e => { if (e.target.id === 'screenshot-modal') closeModal('screenshot-modal'); });

  // Intercept modal
  document.getElementById('int-resume').addEventListener('click', () => resolveIntercept('resume'));
  document.getElementById('int-modify').addEventListener('click', () => resolveIntercept('modify'));
  document.getElementById('int-block').addEventListener('click', () => resolveIntercept('block'));

  // Global search
  document.getElementById('global-search').addEventListener('input', e => {
    globalSearchText = e.target.value.toLowerCase();
    renderNetwork(); renderConsole(); renderWebSockets();
  });

  // Network filters
  document.getElementById('net-filter').addEventListener('input', e => { filterText = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('method-filter').addEventListener('change', e => { filterMethod = e.target.value; renderNetwork(); });
  document.getElementById('type-filter').addEventListener('change', e => { filterType = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('select-all').addEventListener('change', e => {
    const visible = visibleRequests();
    if (e.target.checked) visible.forEach(r => selectedRequests.add(r.id));
    else selectedRequests.clear();
    renderNetwork(); updateSelCount();
  });
  document.getElementById('ask-net-btn').addEventListener('click', () => sendSelectedToChat('network'));

  // Console filters
  document.getElementById('con-filter').addEventListener('input', e => { filterConText = e.target.value.toLowerCase(); renderConsole(); });
  document.getElementById('level-filter').addEventListener('change', e => { filterLevel = e.target.value; renderConsole(); });
  document.getElementById('ask-con-btn').addEventListener('click', () => sendSelectedToChat('console'));

  // WebSocket filters
  document.getElementById('ws-filter').addEventListener('input', renderWebSockets);
  document.getElementById('ws-dir-filter').addEventListener('change', renderWebSockets);
  document.getElementById('ask-ws-btn').addEventListener('click', () => sendSelectedToChat('websockets'));

  // Storage
  document.getElementById('stor-type-filter').addEventListener('change', e => {
    storageType = e.target.value; storageItems = []; selectedStorItems.clear(); renderStorage();
  });
  document.getElementById('stor-filter').addEventListener('input', renderStorage);
  document.getElementById('stor-refresh-btn').addEventListener('click', refreshStorage);
  document.getElementById('stor-select-all').addEventListener('change', e => {
    const visible = visibleStorageItems();
    if (e.target.checked) visible.forEach((_, i) => selectedStorItems.add(i));
    else selectedStorItems.clear();
    renderStorage(); updateStorSelCount();
  });
  document.getElementById('ask-stor-btn').addEventListener('click', () => sendSelectedToChat('storage'));

  // REPL
  document.getElementById('repl-run-btn').addEventListener('click', runRepl);
  document.getElementById('repl-ask-btn').addEventListener('click', sendReplToChat);
  document.getElementById('repl-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runRepl(); } });

  // Chat
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-stop').addEventListener('click', stopChat);
  document.getElementById('chat-prompt').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendChat(); }
    setTimeout(autoResizePrompt, 0);
  });
  document.getElementById('chat-prompt').addEventListener('input', autoResizePrompt);

  populateSettingsForm();
}

// ── Capture ───────────────────────────────────────────────
async function toggleCapture() {
  if (!targetTabId) { alert('No tab to inspect. Open the inspector from the popup button on a page.'); return; }
  if (capturing) {
    await chrome.runtime.sendMessage({ type: 'INS_DETACH', tabId: targetTabId });
    capturing = false;
    clearInterval(pollTimer); pollTimer = null;
    updateCaptureUI();
  } else {
    const r = await chrome.runtime.sendMessage({ type: 'INS_ATTACH', tabId: targetTabId });
    if (!r.ok) { alert('Could not attach debugger: ' + r.error); return; }
    capturing = true;
    updateCaptureUI();
    pollTimer = setInterval(pollData, 1500);
    pollData();
  }
}

function updateCaptureUI() {
  const btn = document.getElementById('capture-btn');
  const dot = document.getElementById('live-dot');
  if (capturing) { btn.textContent = '⏹ Stop'; btn.classList.add('on'); dot.classList.add('live'); }
  else { btn.textContent = '▶ Start'; btn.classList.remove('on'); dot.classList.remove('live'); }
}

async function pollData() {
  if (!targetTabId) return;
  const [netR, conR, wsR] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'INS_NETWORK', tabId: targetTabId }),
    chrome.runtime.sendMessage({ type: 'INS_CONSOLE', tabId: targetTabId }),
    chrome.runtime.sendMessage({ type: 'INS_WS', tabId: targetTabId }),
  ]);
  netRequests = netR.requests || [];
  consoleLogs = conR.logs || [];
  wsConnections = wsR.connections || [];
  renderNetwork(); renderConsole(); renderWebSockets(); updateBadges();
}

async function clearAll() {
  if (targetTabId) await chrome.runtime.sendMessage({ type: 'INS_CLEAR', tabId: targetTabId });
  netRequests = []; consoleLogs = []; wsConnections = []; storageItems = [];
  selectedRequests.clear(); selectedLogs.clear(); selectedWsFrames = []; selectedStorItems.clear();
  expandedRow = null; expandedWsConn = null; lastReplResult = null;
  renderNetwork(); renderConsole(); renderWebSockets(); renderStorage();
  updateBadges(); updateSelCount();
}

// ── DOM Snapshot ──────────────────────────────────────────
async function attachDom() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  const btn = document.getElementById('dom-btn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_DOM', tabId: targetTabId });
    if (!r.ok) { alert('DOM capture failed: ' + r.error); return; }
    chatContext.push({ type: 'dom', data: { html: r.html || '', size: (r.html || '').length } });
    renderChatContextBar(); switchTab('chat');
  } catch (e) { alert('DOM capture error: ' + e.message); }
  finally { btn.textContent = '📄 DOM'; btn.disabled = false; }
}

// ── Screenshot ────────────────────────────────────────────
async function takeScreenshot() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  if (!capturing) { alert('Start capture first (debugger must be attached for screenshots).'); return; }
  const btn = document.getElementById('screenshot-btn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_SCREENSHOT', tabId: targetTabId });
    if (!r.ok) { alert('Screenshot failed: ' + r.error); return; }
    const src = 'data:image/png;base64,' + r.data;
    document.getElementById('screenshot-img').src = src;
    document.getElementById('screenshot-dl').href = src;
    openModal('screenshot-modal');
    // store for attach
    document.getElementById('screenshot-img').dataset.b64 = r.data;
  } catch (e) { alert('Screenshot error: ' + e.message); }
  finally { btn.textContent = '📷 Shot'; btn.disabled = false; }
}

function attachScreenshot() {
  const b64 = document.getElementById('screenshot-img').dataset.b64 || '';
  chatContext.push({ type: 'screenshot', data: { b64, size: b64.length } });
  renderChatContextBar();
  closeModal('screenshot-modal');
  switchTab('chat');
}

// ── Intercept ─────────────────────────────────────────────
async function toggleIntercept() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  if (!capturing) { alert('Start capture first before enabling intercept.'); return; }
  const btn = document.getElementById('intercept-btn');
  if (intercepting) {
    if (interceptPort) { interceptPort.disconnect(); interceptPort = null; }
    intercepting = false;
    btn.classList.remove('on'); btn.textContent = '⚡ Intercept';
  } else {
    interceptPort = chrome.runtime.connect({ name: 'inspector-intercept' });
    interceptPort.postMessage({ type: 'INIT', tabId: targetTabId });
    interceptPort.onMessage.addListener(msg => {
      if (msg.type === 'READY') {
        intercepting = true; btn.classList.add('on'); btn.textContent = '⚡ ON';
      } else if (msg.type === 'ERROR') {
        alert('Intercept error: ' + msg.error);
        interceptPort = null; intercepting = false;
        btn.classList.remove('on'); btn.textContent = '⚡ Intercept';
      } else if (msg.type === 'PAUSED') {
        showInterceptModal(msg);
      }
    });
    interceptPort.onDisconnect.addListener(() => {
      intercepting = false; interceptPort = null;
      btn.classList.remove('on'); btn.textContent = '⚡ Intercept';
    });
  }
}

function showInterceptModal(msg) {
  pendingIntercept = msg;
  document.getElementById('int-url').value = msg.request?.url || '';
  document.getElementById('int-headers').value = JSON.stringify(msg.request?.headers || {}, null, 2);
  document.getElementById('int-body').value = msg.request?.postData || '';
  openModal('intercept-modal');
}

function resolveIntercept(action) {
  if (!interceptPort || !pendingIntercept) return;
  const requestId = pendingIntercept.requestId;
  if (action === 'resume') {
    interceptPort.postMessage({ type: 'RESUME', requestId });
  } else if (action === 'modify') {
    let headers;
    try { headers = JSON.parse(document.getElementById('int-headers').value); } catch { headers = null; }
    interceptPort.postMessage({ type: 'MODIFY', requestId, url: document.getElementById('int-url').value, headers, postData: document.getElementById('int-body').value || null });
  } else {
    interceptPort.postMessage({ type: 'BLOCK', requestId });
  }
  pendingIntercept = null;
  closeModal('intercept-modal');
}

// ── Blocking ──────────────────────────────────────────────
function openBlockModal() {
  if (targetTabId) chrome.runtime.sendMessage({ type: 'INS_GET_BLOCK', tabId: targetTabId }).then(r => { blockPatterns = r.patterns || []; renderBlockList(); });
  openModal('block-modal');
}
function renderBlockList() {
  const el = document.getElementById('block-list');
  if (blockPatterns.length === 0) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px">No patterns — all requests allowed</div>'; return; }
  el.innerHTML = blockPatterns.map((p, i) =>
    `<div class="block-row"><span>${esc(p)}</span><button class="block-rm" data-i="${i}">✕</button></div>`
  ).join('');
  el.querySelectorAll('.block-rm').forEach(b => b.addEventListener('click', () => { blockPatterns.splice(parseInt(b.dataset.i), 1); renderBlockList(); }));
}
function addBlockPattern() {
  const v = document.getElementById('block-input').value.trim();
  if (v && !blockPatterns.includes(v)) { blockPatterns.push(v); renderBlockList(); }
  document.getElementById('block-input').value = '';
}
async function applyBlocking() {
  if (!targetTabId) { alert('No tab selected.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'INS_BLOCK', tabId: targetTabId, patterns: blockPatterns });
  if (!r.ok) alert('Block error: ' + r.error);
  else { alert(`Applied ${blockPatterns.length} block pattern(s).`); closeModal('block-modal'); }
}

// ── Export ────────────────────────────────────────────────
function exportHAR() {
  const entries = netRequests.map(r => ({
    startedDateTime: new Date(r.ts).toISOString(),
    time: r.doneAt ? r.doneAt - r.ts : -1,
    request: {
      method: r.method || 'GET', url: r.url, httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.requestHeaders || {}).map(([name, value]) => ({ name, value })),
      queryString: [], cookies: [], headersSize: -1,
      bodySize: r.requestBody ? r.requestBody.length : 0,
      postData: r.requestBody ? { mimeType: '', text: r.requestBody } : undefined,
    },
    response: {
      status: r.status || 0, statusText: r.statusText || '', httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.responseHeaders || {}).map(([name, value]) => ({ name, value })),
      cookies: [], redirectURL: '', headersSize: -1, bodySize: r.size || -1,
      content: { size: r.size || 0, mimeType: r.mimeType || '', text: r.responseBody || '' },
    },
    cache: {},
    timings: { send: 0, wait: r.ttfb || 0, receive: r.doneAt ? (r.doneAt - r.ts) - (r.ttfb || 0) : 0 },
  }));
  downloadBlob(JSON.stringify({ log: { version: '1.2', creator: { name: 'AI Inspector', version: '1.0' }, entries } }, null, 2), 'capture.har', 'application/json');
}
function exportJSON() {
  downloadBlob(JSON.stringify({ requests: netRequests, console: consoleLogs, websockets: wsConnections.map(c => ({ ...c, frames: c.frames })) }, null, 2), 'capture.json', 'application/json');
}
function downloadBlob(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

// ── JS REPL ───────────────────────────────────────────────
async function runRepl() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  const code = document.getElementById('repl-input').value.trim();
  if (!code) return;
  document.getElementById('repl-input').value = '';
  replHistory.push(code);
  const out = document.getElementById('repl-out');
  const entry = document.createElement('div');
  entry.className = 'repl-entry';
  entry.innerHTML = `<div class="repl-in">${esc(code)}</div>`;
  out.appendChild(entry);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_REPL', tabId: targetTabId, code });
    const resEl = document.createElement('div');
    resEl.className = r.ok ? 'repl-result' : 'repl-error';
    resEl.textContent = r.ok ? r.result : '⚠ ' + r.error;
    entry.appendChild(resEl);
    if (r.ok) { lastReplResult = { code, result: r.result }; document.getElementById('repl-ask-btn').disabled = false; }
  } catch (e) {
    const resEl = document.createElement('div');
    resEl.className = 'repl-error'; resEl.textContent = '⚠ ' + e.message;
    entry.appendChild(resEl);
  }
  out.scrollTop = out.scrollHeight;
}

function sendReplToChat() {
  if (!lastReplResult) return;
  chatContext.push({ type: 'repl', data: lastReplResult });
  renderChatContextBar(); switchTab('chat');
}

// ── Network render ────────────────────────────────────────
function visibleRequests() {
  const gs = globalSearchText;
  return netRequests.filter(r => {
    if (filterText && !r.url.toLowerCase().includes(filterText)) return false;
    if (filterMethod && r.method !== filterMethod) return false;
    if (filterType && !r.type.toLowerCase().includes(filterType)) return false;
    if (gs && !r.url.toLowerCase().includes(gs) && !(r.responseBody || '').toLowerCase().includes(gs)) return false;
    return true;
  });
}

function renderNetwork() {
  const tbody = document.getElementById('net-tbody');
  const empty = document.getElementById('net-empty');
  const visible = visibleRequests();
  if (netRequests.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';

  const maxMs = Math.max(...visible.filter(r => r.ttfb != null).map(r => r.ttfb), 1);

  const rows = [];
  for (const r of visible) {
    const checked = selectedRequests.has(r.id);
    const isExpanded = expandedRow === r.id;
    const statusClass = r.error ? 'status-err' : r.status ? `status-${Math.floor(r.status / 100)}` : '';
    const statusText = r.error ? 'ERR' : (r.status || '…');
    const methodClass = `method-${(r.method || '').toLowerCase()}`;
    const size = r.size != null ? fmtSize(r.size) : '…';
    const urlShort = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';

    const ms = r.ttfb != null ? r.ttfb : (r.doneAt && r.ts ? r.doneAt - r.ts : null);
    const pct = ms != null ? Math.max(2, Math.round((ms / maxMs) * 100)) : 0;
    const timeCell = ms != null
      ? `<div class="wf-wrap"><div class="wf-bar-bg"><div class="wf-bar" style="width:${pct}%"></div></div><span class="wf-ms">${ms}ms</span></div>`
      : '<span class="wf-ms" style="color:var(--muted)">…</span>';

    rows.push(`<tr data-id="${esc(r.id)}" class="${checked ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}">
      <td class="check-col"><input type="checkbox" ${checked ? 'checked' : ''} data-id="${esc(r.id)}"></td>
      <td class="method-col ${methodClass}">${esc(r.method || '')}</td>
      <td class="status-col ${statusClass}">${statusText}</td>
      <td class="type-col">${esc(r.type || '')}</td>
      <td class="size-col">${size}</td>
      <td class="time-col">${timeCell}</td>
      <td class="url-col" title="${esc(r.url)}">${esc(urlShort)}</td>
    </tr>`);

    if (isExpanded) {
      rows.push(`<tr class="detail-row"><td colspan="7"><div class="detail-pane" id="detail-pane-${esc(r.id)}">
        <div class="detail-tabs">
          ${['response-body', 'request-body', 'req-headers', 'res-headers'].map(t =>
            `<div class="d-tab ${expandedDetailTab === t ? 'active' : ''}" data-dtab="${t}" data-id="${esc(r.id)}">${dtabLabel(t)}</div>`
          ).join('')}
          <button class="d-tab-curl" data-curl-id="${esc(r.id)}">Copy cURL</button>
        </div>
        <div class="detail-content">${getDetailContent(r, expandedDetailTab)}</div>
      </div></td></tr>`);
    }
  }
  tbody.innerHTML = rows.join('');

  tbody.querySelectorAll('input[type=checkbox][data-id]').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) selectedRequests.add(id); else selectedRequests.delete(id);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      updateSelCount();
    });
  });
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT' || e.target.classList.contains('d-tab') || e.target.classList.contains('d-tab-curl')) return;
      const id = row.dataset.id;
      expandedRow = expandedRow === id ? null : id;
      renderNetwork();
    });
  });
  tbody.querySelectorAll('.d-tab').forEach(dt => {
    dt.addEventListener('click', e => { e.stopPropagation(); expandedDetailTab = dt.dataset.dtab; renderNetwork(); });
  });
  tbody.querySelectorAll('.d-tab-curl').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const r = netRequests.find(x => x.id === btn.dataset.curlId);
      if (r) { navigator.clipboard.writeText(buildCurl(r)); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy cURL', 1500); }
    });
  });
}

function dtabLabel(t) {
  return { 'response-body': 'Response', 'request-body': 'Request Body', 'req-headers': 'Req Headers', 'res-headers': 'Res Headers' }[t] || t;
}
function getDetailContent(r, tab) {
  switch (tab) {
    case 'response-body': if (r.error) return esc(`Error: ${r.error}`); if (!r.done) return '…loading…'; if (!r.responseBody) return '(empty)'; return esc(prettyJSON(r.responseBody));
    case 'request-body': return r.requestBody ? esc(prettyJSON(r.requestBody)) : '(no body)';
    case 'req-headers': return r.requestHeaders ? esc(fmtHeaders(r.requestHeaders)) : '(none)';
    case 'res-headers': return r.responseHeaders ? esc(fmtHeaders(r.responseHeaders)) : '(none)';
    default: return '';
  }
}
function fmtHeaders(h) { return Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n'); }
function prettyJSON(text) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }

function buildCurl(r) {
  let cmd = `curl -X ${r.method} '${r.url}'`;
  for (const [k, v] of Object.entries(r.requestHeaders || {})) {
    if (k.toLowerCase() === 'content-length') continue;
    cmd += `\\\n  -H '${k}: ${v.replace(/'/g, "\\'")}'`;
  }
  if (r.requestBody) cmd += `\\\n  --data-raw '${r.requestBody.replace(/'/g, "\\'")}'`;
  return cmd;
}

function updateSelCount() {
  const c = selectedRequests.size;
  document.getElementById('sel-count').textContent = c > 0 ? `${c} selected` : '';
  document.getElementById('ask-net-btn').disabled = c === 0;
}

// ── Console render ────────────────────────────────────────
function renderConsole() {
  const list = document.getElementById('con-list');
  const empty = document.getElementById('con-empty');
  const gs = globalSearchText;
  const visible = consoleLogs.filter(l => {
    if (filterLevel && l.level !== filterLevel) return false;
    if (filterConText && !l.text.toLowerCase().includes(filterConText)) return false;
    if (gs && !l.text.toLowerCase().includes(gs)) return false;
    return true;
  });
  if (consoleLogs.length === 0) { list.innerHTML = ''; list.appendChild(empty); empty.style.display = ''; return; }
  empty.style.display = 'none';
  const icons = { error: '✖', warning: '⚠', info: 'ℹ', log: '›', debug: '›' };
  list.innerHTML = visible.map((l, i) => {
    const checked = selectedLogs.has(i);
    return `<div class="log-entry ${esc(l.level)} ${checked ? 'selected' : ''}" data-idx="${i}" style="cursor:pointer">
      <input type="checkbox" ${checked ? 'checked' : ''} data-idx="${i}" style="flex-shrink:0;margin-top:2px">
      <span class="log-icon">${icons[l.level] || '›'}</span>
      <span class="log-text">${esc(l.text)}</span>
      ${l.url ? `<span class="log-src">${esc(shortUrl(l.url))}${l.line ? ':' + l.line : ''}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('input[data-idx]').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const idx = parseInt(cb.dataset.idx);
      if (cb.checked) selectedLogs.add(idx); else selectedLogs.delete(idx);
      updateConSelCount();
    });
  });
  updateConSelCount();
}
function updateConSelCount() {
  const c = selectedLogs.size;
  document.getElementById('con-sel-count').textContent = c > 0 ? `${c} selected` : '';
  document.getElementById('ask-con-btn').disabled = c === 0;
}

// ── WebSockets render ─────────────────────────────────────
function renderWebSockets() {
  const list = document.getElementById('ws-list');
  const empty = document.getElementById('ws-empty');
  const gs = globalSearchText;
  const filterUrl = document.getElementById('ws-filter').value.toLowerCase();
  const filterDir = document.getElementById('ws-dir-filter').value;
  const conns = wsConnections.filter(c =>
    (!filterUrl || c.url.toLowerCase().includes(filterUrl)) &&
    (!gs || c.url.toLowerCase().includes(gs) || c.frames.some(f => f.data.toLowerCase().includes(gs)))
  );
  if (wsConnections.length === 0) { list.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  list.innerHTML = conns.map(conn => {
    const isOpen = expandedWsConn === conn.id;
    const frames = conn.frames.filter(f => !filterDir || f.dir === filterDir);
    const framesHtml = frames.map((f, fi) => {
      const selected = selectedWsFrames.some(s => s.connId === conn.id && s.frameIdx === fi);
      return `<div class="ws-frame">
        <input type="checkbox" data-cid="${esc(conn.id)}" data-fi="${fi}" ${selected ? 'checked' : ''}>
        <span class="ws-dir ${f.dir}">${f.dir === 'sent' ? '↑' : '↓'}</span>
        <div class="ws-data">${esc(tryPrettyWs(f.data))}</div>
        <span class="ws-ts">${fmtTime(f.ts)}</span>
      </div>`;
    }).join('');
    return `<div class="ws-conn ${isOpen ? 'open' : ''}" data-id="${esc(conn.id)}">
      <div class="ws-conn-hdr">
        <div class="ws-dot ${conn.closed ? 'closed' : ''}"></div>
        <span class="ws-conn-url" title="${esc(conn.url)}">${esc(conn.url)}</span>
        <span class="ws-conn-meta">${conn.frames.length} frames ${conn.closed ? '· closed' : '· open'}</span>
      </div>
      <div class="ws-frames">${framesHtml || '<div style="color:var(--muted);font-size:11px;padding:4px">No frames match filter</div>'}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.ws-conn-hdr').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const id = hdr.closest('.ws-conn').dataset.id;
      expandedWsConn = expandedWsConn === id ? null : id;
      renderWebSockets();
    });
  });
  list.querySelectorAll('input[data-cid]').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const cid = cb.dataset.cid, fi = parseInt(cb.dataset.fi);
      if (cb.checked) selectedWsFrames.push({ connId: cid, frameIdx: fi });
      else selectedWsFrames = selectedWsFrames.filter(s => !(s.connId === cid && s.frameIdx === fi));
      updateWsSelCount();
    });
  });
  updateWsSelCount();
}
function tryPrettyWs(data) { try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; } }
function fmtTime(ts) { const d = new Date(ts); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
function updateWsSelCount() {
  const c = selectedWsFrames.length;
  document.getElementById('ws-sel-count').textContent = c > 0 ? `${c} selected` : '';
  document.getElementById('ask-ws-btn').disabled = c === 0;
}

// ── Storage ───────────────────────────────────────────────
async function refreshStorage() {
  if (!targetTabId) return;
  const btn = document.getElementById('stor-refresh-btn');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    if (storageType === 'cookies') {
      const r = await chrome.runtime.sendMessage({ type: 'INS_COOKIES', tabId: targetTabId });
      storageItems = r.ok
        ? r.cookies.map(c => ({ key: c.name, value: JSON.stringify({ value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure }) }))
        : [{ key: 'Error', value: r.error }];
    } else {
      const r = await chrome.runtime.sendMessage({ type: 'INS_STORAGE', tabId: targetTabId });
      storageItems = r.ok
        ? (storageType === 'local' ? r.storage.local : r.storage.session).map(([k, v]) => ({ key: k, value: v }))
        : [{ key: 'Error', value: r.error }];
    }
    selectedStorItems.clear(); renderStorage();
  } finally { btn.textContent = '↻ Refresh'; btn.disabled = false; }
}
function visibleStorageItems() {
  const f = document.getElementById('stor-filter').value.toLowerCase();
  return storageItems.filter(item => !f || item.key.toLowerCase().includes(f) || item.value.toLowerCase().includes(f));
}
function renderStorage() {
  const tbody = document.getElementById('stor-tbody');
  const empty = document.getElementById('stor-empty');
  const visible = visibleStorageItems();
  if (storageItems.length === 0) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  tbody.innerHTML = visible.map((item, i) => {
    const selected = selectedStorItems.has(i);
    return `<tr class="${selected ? 'selected' : ''}" data-idx="${i}">
      <td style="text-align:center"><input type="checkbox" data-idx="${i}" ${selected ? 'checked' : ''}></td>
      <td title="${esc(item.key)}">${esc(item.key)}</td>
      <td title="${esc(item.value)}">${esc(item.value.slice(0, 200))}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('input[data-idx]').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const idx = parseInt(cb.dataset.idx);
      if (cb.checked) selectedStorItems.add(idx); else selectedStorItems.delete(idx);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      updateStorSelCount();
    });
  });
  updateStorSelCount();
}
function updateStorSelCount() {
  const c = selectedStorItems.size;
  document.getElementById('stor-sel-count').textContent = c > 0 ? `${c} selected` : '';
  document.getElementById('ask-stor-btn').disabled = c === 0;
}

// ── Badges ────────────────────────────────────────────────
function updateBadges() {
  const nb = document.getElementById('net-badge');
  const cb = document.getElementById('con-badge');
  const wb = document.getElementById('ws-badge');
  if (netRequests.length > 0) { nb.textContent = netRequests.length; nb.style.display = ''; } else nb.style.display = 'none';
  const errCount = consoleLogs.filter(l => l.level === 'error').length;
  if (errCount > 0) { cb.textContent = errCount; cb.style.display = ''; } else if (consoleLogs.length > 0) { cb.textContent = consoleLogs.length; cb.style.display = ''; } else cb.style.display = 'none';
  const wsTotal = wsConnections.reduce((s, c) => s + c.frames.length, 0);
  if (wsTotal > 0) { wb.textContent = wsTotal; wb.style.display = ''; } else wb.style.display = 'none';
}

// ── Tab switch ────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}

// ── Send context to chat ──────────────────────────────────
function sendSelectedToChat(source) {
  chatContext = [];
  if (source === 'network') {
    for (const id of selectedRequests) { const r = netRequests.find(x => x.id === id); if (r) chatContext.push({ type: 'request', data: r }); }
  } else if (source === 'console') {
    for (const idx of selectedLogs) { const l = consoleLogs[idx]; if (l) chatContext.push({ type: 'log', data: l }); }
  } else if (source === 'websockets') {
    for (const { connId, frameIdx } of selectedWsFrames) { const conn = wsConnections.find(c => c.id === connId); const frame = conn?.frames[frameIdx]; if (frame) chatContext.push({ type: 'wsframe', data: { url: conn.url, ...frame } }); }
  } else if (source === 'storage') {
    const visible = visibleStorageItems();
    for (const idx of selectedStorItems) { const item = visible[idx]; if (item) chatContext.push({ type: 'storage', data: { storageType, ...item } }); }
  }
  renderChatContextBar();
  switchTab('chat');
}

function renderChatContextBar() {
  const bar = document.getElementById('chat-context-bar');
  if (chatContext.length === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = chatContext.map((c, i) => {
    const label = c.type === 'request' ? `${c.data.method} ${shortUrl(c.data.url)} (${c.data.status || 'pending'})`
      : c.type === 'dom' ? `DOM (${fmtSize(c.data.size)})`
      : c.type === 'screenshot' ? `Screenshot`
      : c.type === 'wsframe' ? `WS ${c.data.dir === 'sent' ? '↑' : '↓'} ${c.data.data.slice(0, 25)}`
      : c.type === 'storage' ? `${c.data.storageType}: ${c.data.key}`
      : c.type === 'repl' ? `REPL: ${c.data.code.slice(0, 30)}`
      : `[${c.data.level}] ${c.data.text.slice(0, 40)}`;
    return `<div class="ctx-chip">📎 ${esc(label)} <span class="rm" data-i="${i}">✕</span></div>`;
  }).join('');
  bar.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', () => { chatContext.splice(parseInt(btn.dataset.i), 1); renderChatContextBar(); });
  });
}

// ── Chat ──────────────────────────────────────────────────
function buildContextBlock() {
  if (chatContext.length === 0) return '';
  const parts = chatContext.map(c => {
    if (c.type === 'request') {
      const r = c.data;
      return ['=== Network Request ===', `${r.method} ${r.url}`, `Status: ${r.status || 'pending'} ${r.statusText || ''}`,
        r.requestBody ? `Request Body:\n${prettyJSON(r.requestBody)}` : '',
        r.responseBody ? `Response Body:\n${prettyJSON(r.responseBody).slice(0, 8000)}` : '',
        r.error ? `Error: ${r.error}` : ''].filter(Boolean).join('\n');
    } else if (c.type === 'log') {
      const l = c.data; return `=== Console [${l.level.toUpperCase()}] ===\n${l.text}${l.url ? `\nat ${l.url}${l.line ? ':' + l.line : ''}` : ''}`;
    } else if (c.type === 'dom') {
      return `=== Page DOM Snapshot (${fmtSize(c.data.size)}) ===\n${c.data.html.slice(0, 60000)}`;
    } else if (c.type === 'screenshot') {
      return `=== Page Screenshot ===\n[Base64 PNG attached — ${fmtSize(c.data.size * 0.75)} uncompressed]`;
    } else if (c.type === 'wsframe') {
      const f = c.data; return `=== WebSocket Frame [${f.dir.toUpperCase()}] ===\nURL: ${f.url}\n${tryPrettyWs(f.data)}`;
    } else if (c.type === 'storage') {
      const d = c.data; return `=== ${d.storageType} Storage ===\n${d.key}: ${d.value}`;
    } else if (c.type === 'repl') {
      return `=== JS REPL ===\n> ${c.data.code}\n${c.data.result}`;
    }
    return '';
  });
  return `\n\n[ATTACHED CONTEXT]\n${parts.filter(Boolean).join('\n\n---\n\n')}`;
}

async function sendChat() {
  const prompt = document.getElementById('chat-prompt').value.trim();
  if (!prompt || generating) return;
  if (!settings.model) { alert('Configure a model in ⚙ settings first.'); return; }
  document.getElementById('chat-prompt').value = '';
  autoResizePrompt();
  const contextBlock = buildContextBlock();
  const userContent = prompt + contextBlock;
  chatHistory.push({ role: 'user', content: userContent });
  appendChatMsg('user', prompt + (chatContext.length ? `\n📎 ${chatContext.length} item(s) attached` : ''));
  chatContext = []; renderChatContextBar();
  setGenerating(true);
  const messages = [{ role: 'system', content: settings.systemPrompt }, ...chatHistory];
  let assistantContent = ''; let bubble = null;
  chatPort = chrome.runtime.connect({ name: 'inspector-chat' });
  chatPort.onMessage.addListener(msg => {
    if (msg.type === 'CHUNK') {
      if (!bubble) bubble = appendStreamBubble();
      assistantContent += msg.content; renderBubble(bubble, assistantContent);
    } else if (msg.type === 'DONE' || msg.type === 'ERROR') {
      if (msg.type === 'ERROR') appendChatMsg('assistant', `⚠ ${msg.error}`);
      if (assistantContent) chatHistory.push({ role: 'assistant', content: assistantContent });
      setGenerating(false); chatPort = null;
    }
  });
  chatPort.onDisconnect.addListener(() => { if (generating) setGenerating(false); });
  chatPort.postMessage({ type: 'CHAT', payload: { messages, settings: { apiBaseUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model } } });
  scrollChat();
}
function stopChat() { if (chatPort) { chatPort.disconnect(); chatPort = null; } setGenerating(false); }
function setGenerating(v) {
  generating = v;
  document.getElementById('chat-send').disabled = v;
  document.getElementById('chat-prompt').disabled = v;
  document.getElementById('chat-stop').classList.toggle('vis', v);
  document.getElementById('typing-indicator')?.remove();
  if (v) {
    const el = document.createElement('div'); el.id = 'typing-indicator'; el.className = 'cmsg assistant';
    el.innerHTML = '<div class="cmsg-role">AI</div><div class="typing-dots"><span></span><span></span><span></span></div>';
    document.getElementById('chat-msgs').appendChild(el); scrollChat();
  }
}
function appendChatMsg(role, content) {
  const msgs = document.getElementById('chat-msgs');
  const d = document.createElement('div'); d.className = `cmsg ${role}`;
  d.innerHTML = `<div class="cmsg-role">${role === 'user' ? 'You' : 'AI'}</div><div class="cmsg-bubble">${renderContent(content)}</div>`;
  msgs.appendChild(d); scrollChat(); return d.querySelector('.cmsg-bubble');
}
function appendStreamBubble() {
  document.getElementById('typing-indicator')?.remove();
  const msgs = document.getElementById('chat-msgs');
  const d = document.createElement('div'); d.className = 'cmsg assistant';
  d.innerHTML = '<div class="cmsg-role">AI</div><div class="cmsg-bubble"></div>';
  msgs.appendChild(d); scrollChat(); return d.querySelector('.cmsg-bubble');
}
function renderBubble(el, text) { el.innerHTML = renderContent(text); scrollChat(); }
function renderContent(text) {
  let html = '';
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      const m = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = m?.[1] || 'code'; const code = m?.[2] || part.slice(3, -3);
      html += `<div class="code-block"><div class="code-hdr"><span>${escH(lang)}</span><button class="code-cp" onclick="cpCode(this)">Copy</button></div><pre>${escH(code)}</pre></div>`;
    } else if (part.startsWith('`') && part.endsWith('`')) {
      html += `<code style="background:var(--surface2);padding:1px 4px;border-radius:3px;font-family:monospace">${escH(part.slice(1, -1))}</code>`;
    } else { html += escH(part).replace(/\n/g, '<br>'); }
  }
  return html;
}
function scrollChat() { requestAnimationFrame(() => { const m = document.getElementById('chat-msgs'); m.scrollTop = m.scrollHeight; }); }
function autoResizePrompt() { const el = document.getElementById('chat-prompt'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ── Settings ──────────────────────────────────────────────
function openSettings() { populateSettingsForm(); openModal('settings-modal'); }
function closeSettings() { closeModal('settings-modal'); }
function populateSettingsForm() {
  document.getElementById('s-url').value = settings.apiUrl;
  document.getElementById('s-model').value = settings.model;
  document.getElementById('s-key').value = settings.apiKey;
  document.getElementById('s-sysprompt').value = settings.systemPrompt;
}
async function saveSettingsFromForm() {
  settings.apiUrl = document.getElementById('s-url').value.replace(/\/$/, '');
  settings.model = document.getElementById('s-model').value.trim();
  settings.apiKey = document.getElementById('s-key').value.trim();
  settings.systemPrompt = document.getElementById('s-sysprompt').value;
  await saveSettings(); closeSettings();
}

// ── Modal helpers ─────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── Helpers ───────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escH(s) { return esc(s); }
function shortUrl(url) { try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; } }
function fmtSize(bytes) { if (bytes == null) return ''; if (bytes < 1024) return bytes + 'B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB'; return (bytes / 1048576).toFixed(1) + 'MB'; }

window.cpCode = function (btn) {
  const code = btn.closest('.code-block')?.querySelector('pre')?.textContent || '';
  navigator.clipboard.writeText(code);
  btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500);
};

// ── Start ─────────────────────────────────────────────────
init();
