'use strict';

// ── State ────────────────────────────────────────────────
let targetTabId = null;
let capturing = false;
let netRequests = [];       // [{id,url,method,status,...}]
let consoleLogs = [];       // [{level,text,...}]
let selectedRequests = new Set();
let selectedLogs = new Set();
let chatContext = [];       // items to include in next AI message
let chatHistory = [];       // [{role,content}]
let generating = false;
let chatPort = null;
let settings = {
  apiUrl: 'http://localhost:11434/v1',
  model: '',
  apiKey: '',
  systemPrompt: 'You are an AI assistant integrated into a browser dev tool. You help developers understand network requests, console errors, API responses, and page behavior. Be concise, technical, and precise.',
};
let expandedRow = null;
let expandedDetailTab = 'response-body';
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
    if (tab) {
      document.getElementById('tab-url').textContent = tab.url || 'Unknown tab';
    }
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

// Try to auto-read model config from Nanobrowser's storage
async function tryAutoConfig() {
  if (settings.model) return; // already configured
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
  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Capture button
  document.getElementById('capture-btn').addEventListener('click', toggleCapture);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('dom-btn').addEventListener('click', attachDom);
  document.getElementById('settings-btn').addEventListener('click', openSettings);

  // Settings modal
  document.getElementById('s-cancel').addEventListener('click', closeSettings);
  document.getElementById('s-save').addEventListener('click', saveSettingsFromForm);
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target.id === 'settings-modal') closeSettings();
  });

  // Network filters
  document.getElementById('net-filter').addEventListener('input', e => { filterText = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('method-filter').addEventListener('change', e => { filterMethod = e.target.value; renderNetwork(); });
  document.getElementById('type-filter').addEventListener('change', e => { filterType = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('select-all').addEventListener('change', e => {
    const visible = visibleRequests();
    if (e.target.checked) visible.forEach(r => selectedRequests.add(r.id));
    else selectedRequests.clear();
    renderNetwork();
    updateSelCount();
  });
  document.getElementById('ask-net-btn').addEventListener('click', () => sendSelectedToChat('network'));

  // Console filters
  document.getElementById('con-filter').addEventListener('input', e => { filterConText = e.target.value.toLowerCase(); renderConsole(); });
  document.getElementById('level-filter').addEventListener('change', e => { filterLevel = e.target.value; renderConsole(); });
  document.getElementById('ask-con-btn').addEventListener('click', () => sendSelectedToChat('console'));

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
    clearInterval(pollTimer);
    pollTimer = null;
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
  if (capturing) {
    btn.textContent = '⏹ Stop Capture';
    btn.classList.add('on');
    dot.classList.add('live');
  } else {
    btn.textContent = '▶ Start Capture';
    btn.classList.remove('on');
    dot.classList.remove('live');
  }
}

async function pollData() {
  if (!targetTabId) return;
  const [netR, conR] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'INS_NETWORK', tabId: targetTabId }),
    chrome.runtime.sendMessage({ type: 'INS_CONSOLE', tabId: targetTabId }),
  ]);
  netRequests = netR.requests || [];
  consoleLogs = conR.logs || [];
  renderNetwork();
  renderConsole();
  updateBadges();
}

async function clearAll() {
  if (targetTabId) {
    await chrome.runtime.sendMessage({ type: 'INS_CLEAR', tabId: targetTabId });
  }
  netRequests = [];
  consoleLogs = [];
  selectedRequests.clear();
  selectedLogs.clear();
  expandedRow = null;
  renderNetwork();
  renderConsole();
  updateBadges();
  updateSelCount();
}

// ── DOM Snapshot ──────────────────────────────────────────
async function attachDom() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  const btn = document.getElementById('dom-btn');
  btn.textContent = '⏳ Capturing…';
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_DOM', tabId: targetTabId });
    if (!r.ok) { alert('DOM capture failed: ' + r.error); return; }
    const html = r.html || '';
    chatContext.push({ type: 'dom', data: { html, size: html.length, ts: Date.now() } });
    renderChatContextBar();
    switchTab('chat');
  } catch (e) {
    alert('DOM capture error: ' + e.message);
  } finally {
    btn.textContent = '📄 Attach DOM';
    btn.disabled = false;
  }
}

// ── Network render ────────────────────────────────────────
function visibleRequests() {
  return netRequests.filter(r => {
    if (filterText && !r.url.toLowerCase().includes(filterText)) return false;
    if (filterMethod && r.method !== filterMethod) return false;
    if (filterType && !r.type.toLowerCase().includes(filterType)) return false;
    return true;
  });
}

function renderNetwork() {
  const tbody = document.getElementById('net-tbody');
  const empty = document.getElementById('net-empty');
  const visible = visibleRequests();

  if (netRequests.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const rows = [];
  for (const r of visible) {
    const checked = selectedRequests.has(r.id);
    const isExpanded = expandedRow === r.id;
    const statusClass = r.error ? 'status-err' : r.status ? `status-${Math.floor(r.status/100)}` : '';
    const statusText = r.error ? 'ERR' : (r.status || '…');
    const methodClass = `method-${(r.method || '').toLowerCase()}`;
    const size = r.size != null ? fmtSize(r.size) : '…';
    const urlShort = r.url.replace(/^https?:\/\/[^/]+/, '');

    rows.push(`<tr data-id="${esc(r.id)}" class="${checked ? 'selected' : ''} ${isExpanded ? 'expanded' : ''}">
      <td class="check-col"><input type="checkbox" ${checked ? 'checked' : ''} data-id="${esc(r.id)}"></td>
      <td class="method-col ${methodClass}">${esc(r.method || '')}</td>
      <td class="status-col ${statusClass}">${statusText}</td>
      <td class="type-col">${esc(r.type || '')}</td>
      <td class="size-col">${size}</td>
      <td class="url-col" title="${esc(r.url)}">${esc(urlShort)}</td>
    </tr>`);

    if (isExpanded) {
      rows.push(`<tr class="detail-row"><td colspan="6"><div class="detail-pane" id="detail-pane-${esc(r.id)}">
        <div class="detail-tabs">
          ${['response-body','request-body','req-headers','res-headers'].map(t =>
            `<div class="d-tab ${expandedDetailTab===t?'active':''}" data-dtab="${t}" data-id="${esc(r.id)}">${dtabLabel(t)}</div>`
          ).join('')}
        </div>
        <div class="detail-content">${getDetailContent(r, expandedDetailTab)}</div>
      </div></td></tr>`);
    }
  }

  tbody.innerHTML = rows.join('');

  // Attach events
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
      if (e.target.tagName === 'INPUT') return;
      const id = row.dataset.id;
      expandedRow = expandedRow === id ? null : id;
      renderNetwork();
    });
  });

  tbody.querySelectorAll('.d-tab').forEach(dt => {
    dt.addEventListener('click', e => {
      e.stopPropagation();
      expandedDetailTab = dt.dataset.dtab;
      renderNetwork();
    });
  });
}

function dtabLabel(t) {
  return { 'response-body': 'Response', 'request-body': 'Request Body', 'req-headers': 'Req Headers', 'res-headers': 'Res Headers' }[t] || t;
}

function getDetailContent(r, tab) {
  switch (tab) {
    case 'response-body': {
      if (r.error) return esc(`Error: ${r.error}`);
      if (!r.done) return '…loading…';
      if (!r.responseBody) return '(empty)';
      return esc(prettyJSON(r.responseBody));
    }
    case 'request-body': return r.requestBody ? esc(prettyJSON(r.requestBody)) : '(no body)';
    case 'req-headers': return r.requestHeaders ? esc(fmtHeaders(r.requestHeaders)) : '(none)';
    case 'res-headers': return r.responseHeaders ? esc(fmtHeaders(r.responseHeaders)) : '(none)';
    default: return '';
  }
}

function fmtHeaders(h) {
  if (!h) return '';
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function prettyJSON(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
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
  const visible = consoleLogs.filter(l => {
    if (filterLevel && l.level !== filterLevel) return false;
    if (filterConText && !l.text.toLowerCase().includes(filterConText)) return false;
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

// ── Badges ────────────────────────────────────────────────
function updateBadges() {
  const nb = document.getElementById('net-badge');
  const cb = document.getElementById('con-badge');
  if (netRequests.length > 0) { nb.textContent = netRequests.length; nb.style.display = ''; } else nb.style.display = 'none';
  const errCount = consoleLogs.filter(l => l.level === 'error').length;
  if (errCount > 0) { cb.textContent = errCount; cb.style.display = ''; } else if (consoleLogs.length > 0) { cb.textContent = consoleLogs.length; cb.style.display = ''; } else cb.style.display = 'none';
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
    for (const id of selectedRequests) {
      const r = netRequests.find(x => x.id === id);
      if (r) chatContext.push({ type: 'request', data: r });
    }
  } else {
    for (const idx of selectedLogs) {
      const l = consoleLogs[idx];
      if (l) chatContext.push({ type: 'log', data: l });
    }
  }
  renderChatContextBar();
  switchTab('chat');
}

function renderChatContextBar() {
  const bar = document.getElementById('chat-context-bar');
  if (chatContext.length === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = chatContext.map((c, i) => {
    const label = c.type === 'request'
      ? `${c.data.method} ${shortUrl(c.data.url)} (${c.data.status || 'pending'})`
      : c.type === 'dom'
      ? `DOM snapshot (${fmtSize(c.data.size)})`
      : `[${c.data.level}] ${c.data.text.slice(0, 40)}`;
    return `<div class="ctx-chip">📎 ${esc(label)} <span class="rm" data-i="${i}">✕</span></div>`;
  }).join('');
  bar.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', () => {
      chatContext.splice(parseInt(btn.dataset.i), 1);
      renderChatContextBar();
    });
  });
}

// ── Chat ──────────────────────────────────────────────────
function buildContextBlock() {
  if (chatContext.length === 0) return '';
  const parts = chatContext.map(c => {
    if (c.type === 'request') {
      const r = c.data;
      return [
        `=== Network Request ===`,
        `${r.method} ${r.url}`,
        `Status: ${r.status || 'pending'} ${r.statusText || ''}`,
        r.requestBody ? `Request Body:\n${prettyJSON(r.requestBody)}` : '',
        r.responseBody ? `Response Body:\n${prettyJSON(r.responseBody).slice(0, 8000)}` : '',
        r.error ? `Error: ${r.error}` : '',
      ].filter(Boolean).join('\n');
    } else if (c.type === 'dom') {
      return `=== Page DOM Snapshot (${fmtSize(c.data.size)}) ===\n${c.data.html.slice(0, 60000)}`;
    } else {
      const l = c.data;
      return `=== Console [${l.level.toUpperCase()}] ===\n${l.text}${l.url ? `\nat ${l.url}${l.line ? ':' + l.line : ''}` : ''}`;
    }
  });
  return `\n\n[ATTACHED CONTEXT]\n${parts.join('\n\n---\n\n')}`;
}

async function sendChat() {
  const prompt = document.getElementById('chat-prompt').value.trim();
  if (!prompt || generating) return;
  if (!settings.model) { alert('Configure a model in ⚙ Model settings first.'); return; }

  document.getElementById('chat-prompt').value = '';
  autoResizePrompt();

  const contextBlock = buildContextBlock();
  const userContent = prompt + contextBlock;

  chatHistory.push({ role: 'user', content: userContent });
  appendChatMsg('user', prompt + (chatContext.length ? `\n📎 ${chatContext.length} item(s) attached` : ''));

  chatContext = [];
  renderChatContextBar();

  setGenerating(true);

  const messages = [
    { role: 'system', content: settings.systemPrompt },
    ...chatHistory,
  ];

  let assistantContent = '';
  let bubble = null;

  chatPort = chrome.runtime.connect({ name: 'inspector-chat' });

  chatPort.onMessage.addListener(msg => {
    if (msg.type === 'CHUNK') {
      if (!bubble) bubble = appendStreamBubble();
      assistantContent += msg.content;
      renderBubble(bubble, assistantContent);
    } else if (msg.type === 'DONE' || msg.type === 'ERROR') {
      if (msg.type === 'ERROR') appendChatMsg('assistant', `⚠ ${msg.error}`);
      if (assistantContent) chatHistory.push({ role: 'assistant', content: assistantContent });
      setGenerating(false);
      chatPort = null;
    }
  });

  chatPort.onDisconnect.addListener(() => { if (generating) setGenerating(false); });

  chatPort.postMessage({
    type: 'CHAT',
    payload: { messages, settings: { apiBaseUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model } },
  });

  scrollChat();
}

function stopChat() {
  if (chatPort) { chatPort.disconnect(); chatPort = null; }
  setGenerating(false);
}

function setGenerating(v) {
  generating = v;
  document.getElementById('chat-send').disabled = v;
  document.getElementById('chat-prompt').disabled = v;
  document.getElementById('chat-stop').classList.toggle('vis', v);
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.style.display = v ? '' : 'none';
  if (v && !document.getElementById('typing-indicator')) {
    const el = document.createElement('div');
    el.id = 'typing-indicator';
    el.className = 'cmsg assistant';
    el.innerHTML = '<div class="cmsg-role">AI</div><div class="typing-dots"><span></span><span></span><span></span></div>';
    document.getElementById('chat-msgs').appendChild(el);
    scrollChat();
  } else if (!v) {
    document.getElementById('typing-indicator')?.remove();
  }
}

function appendChatMsg(role, content) {
  const msgs = document.getElementById('chat-msgs');
  const d = document.createElement('div');
  d.className = `cmsg ${role}`;
  d.innerHTML = `<div class="cmsg-role">${role === 'user' ? 'You' : 'AI'}</div><div class="cmsg-bubble">${renderContent(content)}</div>`;
  msgs.appendChild(d);
  scrollChat();
  return d.querySelector('.cmsg-bubble');
}

function appendStreamBubble() {
  document.getElementById('typing-indicator')?.remove();
  const msgs = document.getElementById('chat-msgs');
  const d = document.createElement('div');
  d.className = 'cmsg assistant';
  d.innerHTML = '<div class="cmsg-role">AI</div><div class="cmsg-bubble"></div>';
  msgs.appendChild(d);
  scrollChat();
  return d.querySelector('.cmsg-bubble');
}

function renderBubble(el, text) {
  el.innerHTML = renderContent(text);
  scrollChat();
}

function renderContent(text) {
  let html = '';
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      const m = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = m?.[1] || 'code';
      const code = m?.[2] || part.slice(3, -3);
      html += `<div class="code-block"><div class="code-hdr"><span>${escH(lang)}</span><button class="code-cp" onclick="cpCode(this)">Copy</button></div><pre>${escH(code)}</pre></div>`;
    } else if (part.startsWith('`') && part.endsWith('`')) {
      html += `<code style="background:var(--surface2);padding:1px 4px;border-radius:3px;font-family:monospace">${escH(part.slice(1,-1))}</code>`;
    } else {
      html += escH(part).replace(/\n/g, '<br>');
    }
  }
  return html;
}

function scrollChat() {
  requestAnimationFrame(() => {
    const m = document.getElementById('chat-msgs');
    m.scrollTop = m.scrollHeight;
  });
}

function autoResizePrompt() {
  const el = document.getElementById('chat-prompt');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Settings ──────────────────────────────────────────────
function openSettings() {
  populateSettingsForm();
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }

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
  await saveSettings();
  closeSettings();
}

// ── Helpers ───────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escH(s) { return esc(s); }
function shortUrl(url) { try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; } }
function fmtSize(bytes) { if (bytes == null) return ''; if (bytes < 1024) return bytes + 'B'; if (bytes < 1024*1024) return (bytes/1024).toFixed(1)+'KB'; return (bytes/1024/1024).toFixed(1)+'MB'; }

window.cpCode = function(btn) {
  const code = btn.closest('.code-block')?.querySelector('pre')?.textContent || '';
  navigator.clipboard.writeText(code);
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
};

// ── Start ─────────────────────────────────────────────────
init();
