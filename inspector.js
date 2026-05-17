'use strict';

// ── State ─────────────────────────────────────────────────
let targetTabId = null, capturing = false;
let netRequests = [], consoleLogs = [], wsConnections = [], storageItems = [];
let storageType = 'local', mockRules = [], blockPatterns = [];
let replHistory = [], lastReplResult = null;
let selectedRequests = new Set(), selectedLogs = new Set();
let selectedWsFrames = [], selectedStorItems = new Set();
let chatContext = [], chatHistory = [], generating = false, chatPort = null;
let interceptPort = null, intercepting = false, pendingIntercept = null;
let globalSearch = '', expandedRow = null, expandedDTab = 'response-body', expandedWsConn = null;
let pollTimer = null;
let filterText='', filterMethod='', filterType='', filterLevel='', filterConText='';
let throttlePreset = 'none', consoleGrouped = false, expandedGroups = new Set();
let replayResult = null, selectedSessions = new Set();
let settings = {
  apiUrl: 'http://localhost:11434/v1', model: '', apiKey: '',
  systemPrompt: 'You are an AI assistant integrated into a browser dev tool. Help developers understand network requests, console errors, security issues, and page behavior. Be concise, technical, and precise.',
};

// ── Init ──────────────────────────────────────────────────
async function init() {
  const p = new URLSearchParams(location.search);
  targetTabId = parseInt(p.get('tabId')) || null;
  await loadSettings(); await tryAutoConfig();
  if (targetTabId) {
    const tab = await chrome.tabs.get(targetTabId).catch(() => null);
    if (tab) document.getElementById('tab-url').textContent = tab.url || 'Unknown';
  } else { document.getElementById('tab-url').textContent = 'No tab — open from popup'; }
  setupUI();
}

async function loadSettings() {
  const s = await chrome.storage.local.get('inspector-settings');
  if (s['inspector-settings']) Object.assign(settings, s['inspector-settings']);
}
async function saveSettings() { await chrome.storage.local.set({ 'inspector-settings': settings }); }

async function tryAutoConfig() {
  if (settings.model) return;
  try {
    const d = await chrome.storage.local.get(['llm-api-keys','agent-models']);
    const prov = d['llm-api-keys']?.providers || {}, agents = d['agent-models']?.agents || {};
    const nav = agents['navigator'];
    if (nav?.provider && prov[nav.provider]) {
      const pp = prov[nav.provider];
      settings.apiUrl = pp.baseUrl || settings.apiUrl;
      settings.apiKey = pp.apiKey || '';
      settings.model = nav.modelName || pp.modelNames?.[0] || '';
      await saveSettings();
      document.getElementById('s-nb-hint').textContent = `✓ Auto-imported: ${settings.model} @ ${settings.apiUrl}`;
    }
  } catch {}
}

// ── UI Setup ──────────────────────────────────────────────
function setupUI() {
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Toolbar
  document.getElementById('capture-btn').addEventListener('click', toggleCapture);
  document.getElementById('intercept-btn').addEventListener('click', toggleIntercept);
  document.getElementById('scan-btn').addEventListener('click', autoScan);
  document.getElementById('settings-btn').addEventListener('click', () => { populateSettingsForm(); openModal('settings-modal'); });

  // Tools dropdown
  const toolsBtn = document.getElementById('tools-btn');
  const toolsMenu = document.getElementById('tools-menu');
  toolsBtn.addEventListener('click', e => { e.stopPropagation(); toolsMenu.classList.toggle('open'); });
  document.addEventListener('click', () => toolsMenu.classList.remove('open'));
  const toolAction = (id, fn) => document.getElementById(id).addEventListener('click', () => { toolsMenu.classList.remove('open'); fn(); });
  toolAction('tool-dom', attachDom);
  toolAction('tool-shot', takeScreenshot);
  toolAction('tool-har', exportHAR);
  toolAction('tool-json', exportJSON);
  toolAction('tool-block', openBlockModal);
  toolAction('tool-mocks', openMocksModal);
  toolAction('tool-save', saveSession);
  toolAction('tool-sessions', openSessionsModal);
  toolAction('tool-clear', clearAll);

  // Settings modal
  document.getElementById('s-cancel').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('s-save').addEventListener('click', saveSettingsFromForm);
  document.getElementById('settings-modal').addEventListener('click', e => { if (e.target.id === 'settings-modal') closeModal('settings-modal'); });

  // Block modal
  document.getElementById('block-cancel').addEventListener('click', () => closeModal('block-modal'));
  document.getElementById('block-apply').addEventListener('click', applyBlocking);
  document.getElementById('block-add-btn').addEventListener('click', addBlockPattern);
  document.getElementById('block-input').addEventListener('keydown', e => { if (e.key === 'Enter') addBlockPattern(); });

  // Mocks modal
  document.getElementById('mock-cancel').addEventListener('click', () => closeModal('mocks-modal'));
  document.getElementById('mock-add-btn').addEventListener('click', addMockRule);
  document.getElementById('mock-apply-btn').addEventListener('click', applyMocks);

  // Sessions modal
  document.getElementById('sessions-close').addEventListener('click', () => closeModal('sessions-modal'));

  // Screenshot modal
  document.getElementById('screenshot-close').addEventListener('click', () => closeModal('screenshot-modal'));
  document.getElementById('screenshot-attach').addEventListener('click', attachScreenshot);

  // Intercept modal
  document.getElementById('int-resume').addEventListener('click', () => resolveIntercept('resume'));
  document.getElementById('int-modify').addEventListener('click', () => resolveIntercept('modify'));
  document.getElementById('int-block').addEventListener('click', () => resolveIntercept('block'));

  // Throttle dropdown
  const throttleBtn = document.getElementById('throttle-btn');
  const throttleMenu = document.getElementById('throttle-menu');
  throttleBtn.addEventListener('click', e => { e.stopPropagation(); throttleMenu.classList.toggle('open'); });
  document.addEventListener('click', () => throttleMenu.classList.remove('open'));
  throttleMenu.querySelectorAll('[data-preset]').forEach(item => item.addEventListener('click', () => { throttleMenu.classList.remove('open'); setThrottle(item.dataset.preset); }));

  // Console group toggle
  document.getElementById('con-group-btn').addEventListener('click', () => { consoleGrouped = !consoleGrouped; document.getElementById('con-group-btn').classList.toggle('on', consoleGrouped); renderConsole(); });

  // Replay modal
  document.getElementById('rp-close').addEventListener('click', () => closeModal('replay-modal'));
  document.getElementById('rp-send').addEventListener('click', runReplay);
  document.getElementById('rp-attach').addEventListener('click', attachReplayResult);
  document.getElementById('replay-modal').addEventListener('click', e => { if (e.target.id === 'replay-modal') closeModal('replay-modal'); });

  // Diff modal
  document.getElementById('diff-close').addEventListener('click', () => closeModal('diff-modal'));

  // Global search
  document.getElementById('global-search').addEventListener('input', e => { globalSearch = e.target.value.toLowerCase(); renderNetwork(); renderConsole(); renderWebSockets(); });

  // Network
  document.getElementById('net-filter').addEventListener('input', e => { filterText = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('method-filter').addEventListener('change', e => { filterMethod = e.target.value; renderNetwork(); });
  document.getElementById('type-filter').addEventListener('change', e => { filterType = e.target.value.toLowerCase(); renderNetwork(); });
  document.getElementById('select-all').addEventListener('change', e => { const v = visibleReqs(); if (e.target.checked) v.forEach(r => selectedRequests.add(r.id)); else selectedRequests.clear(); renderNetwork(); updateSelCount(); });
  document.getElementById('ask-net-btn').addEventListener('click', () => sendToChat('network'));

  // Console
  document.getElementById('con-filter').addEventListener('input', e => { filterConText = e.target.value.toLowerCase(); renderConsole(); });
  document.getElementById('level-filter').addEventListener('change', e => { filterLevel = e.target.value; renderConsole(); });
  document.getElementById('ask-con-btn').addEventListener('click', () => sendToChat('console'));

  // WebSockets
  document.getElementById('ws-filter').addEventListener('input', renderWebSockets);
  document.getElementById('ws-dir-filter').addEventListener('change', renderWebSockets);
  document.getElementById('ask-ws-btn').addEventListener('click', () => sendToChat('websockets'));

  // Storage
  document.getElementById('stor-type-filter').addEventListener('change', e => { storageType = e.target.value; storageItems = []; selectedStorItems.clear(); renderStorage(); });
  document.getElementById('stor-filter').addEventListener('input', renderStorage);
  document.getElementById('stor-refresh-btn').addEventListener('click', refreshStorage);
  document.getElementById('stor-select-all').addEventListener('change', e => { const v = visibleStorItems(); if (e.target.checked) v.forEach((_, i) => selectedStorItems.add(i)); else selectedStorItems.clear(); renderStorage(); updateStorSel(); });
  document.getElementById('ask-stor-btn').addEventListener('click', () => sendToChat('storage'));

  // REPL
  document.getElementById('repl-run-btn').addEventListener('click', runRepl);
  document.getElementById('repl-ask-btn').addEventListener('click', () => { if (lastReplResult) { chatContext.push({ type: 'repl', data: lastReplResult }); renderCtxBar(); switchTab('chat'); } });
  document.getElementById('repl-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runRepl(); } });

  // Performance
  document.getElementById('perf-scan-btn').addEventListener('click', () => { const ctx = buildPerfContext(); if (ctx) { chatContext.push({ type: 'perf', data: { text: ctx } }); renderCtxBar(); switchTab('chat'); } });

  // Security
  document.getElementById('sec-run-btn').addEventListener('click', runSecurityAudit);
  document.getElementById('sec-ask-btn').addEventListener('click', () => { const ctx = buildSecContext(); if (ctx) { chatContext.push({ type: 'security', data: { text: ctx } }); renderCtxBar(); switchTab('chat'); } });

  // Chat
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-stop').addEventListener('click', stopChat);
  document.getElementById('chat-prompt').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendChat(); } setTimeout(autoResize, 0); });
  document.getElementById('chat-prompt').addEventListener('input', autoResize);

  populateSettingsForm();
}

// ── Capture ────────────────────────────────────────────────
async function toggleCapture() {
  if (!targetTabId) { alert('No tab to inspect.'); return; }
  if (capturing) {
    await chrome.runtime.sendMessage({ type: 'INS_DETACH', tabId: targetTabId });
    capturing = false; clearInterval(pollTimer); pollTimer = null; updateCaptureUI();
  } else {
    const r = await chrome.runtime.sendMessage({ type: 'INS_ATTACH', tabId: targetTabId });
    if (!r.ok) { alert('Could not attach: ' + r.error); return; }
    capturing = true; updateCaptureUI();
    pollTimer = setInterval(pollData, 1500); pollData();
  }
}
function updateCaptureUI() {
  const btn = document.getElementById('capture-btn'), dot = document.getElementById('live-dot');
  if (capturing) { btn.textContent = '⏹ Stop'; btn.classList.add('on'); dot.classList.add('live'); }
  else { btn.textContent = '▶ Start'; btn.classList.remove('on'); dot.classList.remove('live'); }
}
async function pollData() {
  if (!targetTabId) return;
  const [nr, cr, wr] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'INS_NETWORK', tabId: targetTabId }),
    chrome.runtime.sendMessage({ type: 'INS_CONSOLE', tabId: targetTabId }),
    chrome.runtime.sendMessage({ type: 'INS_WS', tabId: targetTabId }),
  ]);
  netRequests = nr.requests || []; consoleLogs = cr.logs || []; wsConnections = wr.connections || [];
  renderNetwork(); renderConsole(); renderWebSockets(); updateBadges(); updatePerfLive(); updateSecLive();
}
async function clearAll() {
  if (targetTabId) await chrome.runtime.sendMessage({ type: 'INS_CLEAR', tabId: targetTabId });
  netRequests = []; consoleLogs = []; wsConnections = []; storageItems = [];
  selectedRequests.clear(); selectedLogs.clear(); selectedWsFrames = []; selectedStorItems.clear();
  expandedRow = null; expandedWsConn = null; lastReplResult = null;
  renderNetwork(); renderConsole(); renderWebSockets(); renderStorage();
  document.getElementById('perf-empty').style.display = ''; document.getElementById('perf-wrap').querySelectorAll(':not(#perf-empty)').forEach(e => e.remove());
  document.getElementById('sec-empty').style.display = ''; document.getElementById('sec-wrap').querySelectorAll(':not(#sec-empty)').forEach(e => e.remove());
  document.getElementById('sec-badge').style.display = 'none';
  updateBadges(); updateSelCount();
}

// ── DOM / Screenshot ──────────────────────────────────────
async function attachDom() {
  if (!targetTabId) { alert('No tab.'); return; }
  const btn = document.getElementById('tool-dom'); btn.textContent = '⏳ DOM…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_DOM', tabId: targetTabId });
    if (!r.ok) { alert('DOM failed: ' + r.error); return; }
    chatContext.push({ type: 'dom', data: { html: r.html || '', size: (r.html || '').length } });
    renderCtxBar(); switchTab('chat');
  } catch(e) { alert(e.message); }
  finally { btn.textContent = '📄 Attach DOM'; }
}
async function takeScreenshot() {
  if (!targetTabId) { alert('No tab.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_SCREENSHOT', tabId: targetTabId });
    if (!r.ok) { alert('Screenshot failed: ' + r.error); return; }
    const src = 'data:image/png;base64,' + r.data;
    document.getElementById('screenshot-img').src = src;
    document.getElementById('screenshot-img').dataset.b64 = r.data;
    document.getElementById('screenshot-dl').href = src;
    openModal('screenshot-modal');
  } catch(e) { alert(e.message); }
}
function attachScreenshot() {
  const b64 = document.getElementById('screenshot-img').dataset.b64 || '';
  chatContext.push({ type: 'screenshot', data: { b64, size: b64.length } });
  renderCtxBar(); closeModal('screenshot-modal'); switchTab('chat');
}

// ── Sessions ──────────────────────────────────────────────
async function saveSession() {
  if (!netRequests.length && !consoleLogs.length) { alert('Nothing captured yet.'); return; }
  const name = prompt('Session name:', new Date().toLocaleString());
  if (!name) return;
  const { 'inspector-sessions': existing = [] } = await chrome.storage.local.get('inspector-sessions');
  const sessions = [{ id: Date.now(), name, ts: Date.now(), requests: netRequests.slice(), console: consoleLogs.slice(), ws: wsConnections.map(c => ({ ...c })) }, ...existing].slice(0, 15);
  await chrome.storage.local.set({ 'inspector-sessions': sessions });
  alert(`Session "${name}" saved (${netRequests.length} requests, ${consoleLogs.length} logs).`);
}
async function openSessionsModal() {
  selectedSessions = new Set();
  const { 'inspector-sessions': sessions = [] } = await chrome.storage.local.get('inspector-sessions');
  const list = document.getElementById('sessions-list');
  if (!sessions.length) { list.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:6px">No saved sessions yet.</div>'; }
  else {
    list.innerHTML = sessions.map((s, i) =>
      `<div class="sess-item" data-i="${i}" style="align-items:flex-start">
        <input type="checkbox" data-i="${i}" style="flex-shrink:0;margin-top:3px" title="Select for diff">
        <div style="flex:1">
          <div class="sess-name">${esc(s.name)}</div>
          <div class="sess-meta">${new Date(s.ts).toLocaleString()} · ${s.requests?.length||0} req · ${s.console?.length||0} logs</div>
        </div>
        <button class="sess-del" data-i="${i}">✕</button>
      </div>`
    ).join('');
    list.querySelectorAll('input[type=checkbox][data-i]').forEach(cb => {
      cb.addEventListener('change', e => { e.stopPropagation(); const i = parseInt(cb.dataset.i); if (cb.checked) selectedSessions.add(i); else selectedSessions.delete(i); });
    });
    list.querySelectorAll('.sess-item').forEach(el => {
      el.addEventListener('click', async e => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('sess-del')) return;
        const s = sessions[parseInt(el.dataset.i)];
        netRequests = s.requests || []; consoleLogs = s.console || []; wsConnections = s.ws || [];
        renderNetwork(); renderConsole(); renderWebSockets(); updateBadges();
        closeModal('sessions-modal');
      });
    });
    list.querySelectorAll('.sess-del').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        sessions.splice(parseInt(btn.dataset.i), 1);
        await chrome.storage.local.set({ 'inspector-sessions': sessions });
        openSessionsModal();
      });
    });
  }
  // Diff button
  let hint = document.getElementById('sessions-hint');
  hint.innerHTML = 'Click to load · Checkbox two sessions then <button class="s-btn sec" id="sess-diff-btn" style="padding:2px 8px;font-size:11px">⇄ Diff</button>';
  document.getElementById('sess-diff-btn')?.addEventListener('click', () => {
    const idxs = [...selectedSessions];
    if (idxs.length !== 2) { alert('Select exactly 2 sessions to diff.'); return; }
    diffSessions(sessions[idxs[0]], sessions[idxs[1]]);
  });
  openModal('sessions-modal');
}

function diffSessions(a, b) {
  const aUrls = new Map((a.requests||[]).map(r => [r.url, r]));
  const bUrls = new Map((b.requests||[]).map(r => [r.url, r]));
  const added = [], removed = [], changed = [];
  for (const [url, rb] of bUrls) { if (!aUrls.has(url)) added.push(rb); }
  for (const [url, ra] of aUrls) {
    if (!bUrls.has(url)) { removed.push(ra); continue; }
    const rb = bUrls.get(url);
    if (ra.status !== rb.status) changed.push({ url, from: ra.status, to: rb.status });
  }
  const aErrs = new Set((a.console||[]).filter(l=>l.level==='error').map(l=>l.text));
  const newErrs = (b.console||[]).filter(l=>l.level==='error'&&!aErrs.has(l.text));

  document.getElementById('diff-label').textContent = `"${a.name}" vs "${b.name}"`;
  const el = document.getElementById('diff-content');
  let html = '';
  if (!added.length && !removed.length && !changed.length && !newErrs.length) {
    html = '<div style="color:var(--muted);font-size:12px;padding:8px">No differences found.</div>';
  }
  if (added.length) html += `<div class="perf-section"><div class="perf-hdr diff-added">+ ${added.length} New Request(s)</div><div class="diff-section">${added.map(r=>`<div class="diff-item added"><span class="mg">${esc(r.method)}</span> <span class="diff-url">${esc(r.url)}</span> <span style="color:var(--muted)">${r.status||'?'}</span></div>`).join('')}</div></div>`;
  if (removed.length) html += `<div class="perf-section"><div class="perf-hdr diff-removed">- ${removed.length} Removed Request(s)</div><div class="diff-section">${removed.map(r=>`<div class="diff-item removed"><span class="mg">${esc(r.method)}</span> <span class="diff-url">${esc(r.url)}</span></div>`).join('')}</div></div>`;
  if (changed.length) html += `<div class="perf-section"><div class="perf-hdr diff-changed">~ ${changed.length} Status Change(s)</div><div class="diff-section">${changed.map(c=>`<div class="diff-item changed"><span class="diff-url">${esc(c.url)}</span> <span style="color:var(--err)">${c.from}</span> → <span style="color:var(--green)">${c.to}</span></div>`).join('')}</div></div>`;
  if (newErrs.length) html += `<div class="perf-section"><div class="perf-hdr diff-removed">⚠ ${newErrs.length} New Console Error(s)</div><div class="diff-section">${newErrs.map(e=>`<div class="diff-item removed"><span style="color:var(--err)">${esc(e.text.slice(0,120))}</span></div>`).join('')}</div></div>`;
  el.innerHTML = html;
  closeModal('sessions-modal'); openModal('diff-modal');
}

// ── Throttle ──────────────────────────────────────────────
async function setThrottle(preset) {
  if (!targetTabId) { alert('No tab selected.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'INS_THROTTLE', tabId: targetTabId, preset });
  if (!r.ok) { alert('Throttle failed: ' + r.error); return; }
  throttlePreset = preset;
  const btn = document.getElementById('throttle-btn');
  const labels = { none: '🐢 Throttle', slow3g: '🐢 Slow 3G', fast3g: '🐢 Fast 3G', '4g': '🐢 4G' };
  btn.textContent = labels[preset] || '🐢 Throttle';
  btn.classList.toggle('throttle-on', preset !== 'none');
}

// ── Request Replay ────────────────────────────────────────
function openReplayModal(req) {
  document.getElementById('rp-url').value = req.url;
  document.getElementById('rp-method').value = req.method || 'GET';
  document.getElementById('rp-headers').value = req.requestHeaders ? JSON.stringify(req.requestHeaders, null, 2) : '{}';
  document.getElementById('rp-body').value = req.requestBody || '';
  document.getElementById('rp-result').style.display = 'none';
  replayResult = null;
  openModal('replay-modal');
}
async function runReplay() {
  const url = document.getElementById('rp-url').value.trim();
  if (!url) { alert('Enter a URL.'); return; }
  const method = document.getElementById('rp-method').value;
  let headers; try { headers = JSON.parse(document.getElementById('rp-headers').value || '{}'); } catch { headers = {}; }
  const body = document.getElementById('rp-body').value || null;
  const btn = document.getElementById('rp-send'); btn.textContent = '⏳ Sending…'; btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_REPLAY', tabId: targetTabId, url, method, headers, body });
    if (!r.ok) { alert('Replay error: ' + r.error); return; }
    replayResult = r;
    const sc = r.status >= 400 ? 'var(--err)' : r.status >= 300 ? 'var(--warn)' : 'var(--green)';
    document.getElementById('rp-status').innerHTML = `<span style="color:${sc}">${r.status} ${esc(r.statusText)}</span>`;
    document.getElementById('rp-body-out').textContent = prettyJSON(r.body);
    document.getElementById('rp-result').style.display = '';
  } finally { btn.textContent = 'Send ↺'; btn.disabled = false; }
}
function attachReplayResult() {
  if (!replayResult) return;
  chatContext.push({ type: 'replay', data: replayResult });
  renderCtxBar(); closeModal('replay-modal'); switchTab('chat');
}

// ── Mocks ─────────────────────────────────────────────────
function openMocksModal() {
  renderMockList(); openModal('mocks-modal');
}
function addMockRule() {
  const pattern = document.getElementById('mock-pattern').value.trim();
  if (!pattern) { alert('Enter a URL pattern.'); return; }
  mockRules.push({ pattern, status: parseInt(document.getElementById('mock-status').value) || 200, contentType: document.getElementById('mock-ctype').value || 'application/json', body: document.getElementById('mock-body').value });
  document.getElementById('mock-pattern').value = ''; document.getElementById('mock-body').value = '';
  renderMockList();
}
function renderMockList() {
  const el = document.getElementById('mock-list');
  if (!mockRules.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px">No rules — all requests pass through.</div>'; return; }
  el.innerHTML = mockRules.map((m, i) =>
    `<div class="mock-item">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="mock-pat">${esc(m.pattern)}</span>
        <button class="mock-del" data-i="${i}">✕ Remove</button>
      </div>
      <div style="font-size:10px;color:var(--muted)">${m.status} ${esc(m.contentType)} · ${m.body.slice(0,60)}${m.body.length>60?'…':''}</div>
    </div>`
  ).join('');
  el.querySelectorAll('.mock-del').forEach(btn => {
    btn.addEventListener('click', () => { mockRules.splice(parseInt(btn.dataset.i), 1); renderMockList(); });
  });
}
async function applyMocks() {
  if (!targetTabId) { alert('No tab selected.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'INS_MOCK_SET', tabId: targetTabId, mocks: mockRules });
  if (r.ok) { alert(`${mockRules.length} mock rule(s) applied. Matching requests will return fake responses.`); closeModal('mocks-modal'); }
  else alert('Error: ' + r.error);
}

// ── Blocking ──────────────────────────────────────────────
async function openBlockModal() {
  if (targetTabId) { const r = await chrome.runtime.sendMessage({ type: 'INS_GET_BLOCK', tabId: targetTabId }); blockPatterns = r.patterns || []; }
  renderBlockList(); openModal('block-modal');
}
function renderBlockList() {
  const el = document.getElementById('block-list');
  if (!blockPatterns.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px">No patterns — all requests allowed.</div>'; return; }
  el.innerHTML = blockPatterns.map((p, i) => `<div class="block-row"><span>${esc(p)}</span><button class="block-rm" data-i="${i}">✕</button></div>`).join('');
  el.querySelectorAll('.block-rm').forEach(b => b.addEventListener('click', () => { blockPatterns.splice(parseInt(b.dataset.i), 1); renderBlockList(); }));
}
function addBlockPattern() {
  const v = document.getElementById('block-input').value.trim();
  if (v && !blockPatterns.includes(v)) { blockPatterns.push(v); renderBlockList(); }
  document.getElementById('block-input').value = '';
}
async function applyBlocking() {
  if (!targetTabId) { alert('No tab.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'INS_BLOCK', tabId: targetTabId, patterns: blockPatterns });
  if (r.ok) { alert(`${blockPatterns.length} pattern(s) applied.`); closeModal('block-modal'); }
  else alert('Error: ' + r.error);
}

// ── Intercept ─────────────────────────────────────────────
async function toggleIntercept() {
  if (!targetTabId) { alert('No tab.'); return; }
  if (!capturing) { alert('Start capture first.'); return; }
  const btn = document.getElementById('intercept-btn');
  if (intercepting) {
    if (interceptPort) { interceptPort.disconnect(); interceptPort = null; }
    intercepting = false; btn.classList.remove('warn-on'); btn.textContent = '⚡ Intercept';
  } else {
    interceptPort = chrome.runtime.connect({ name: 'inspector-intercept' });
    interceptPort.postMessage({ type: 'INIT', tabId: targetTabId });
    interceptPort.onMessage.addListener(msg => {
      if (msg.type === 'READY') { intercepting = true; btn.classList.add('warn-on'); btn.textContent = '⚡ ON'; }
      else if (msg.type === 'ERROR') { alert('Intercept error: ' + msg.error); interceptPort = null; intercepting = false; btn.classList.remove('warn-on'); btn.textContent = '⚡ Intercept'; }
      else if (msg.type === 'PAUSED') showInterceptModal(msg);
    });
    interceptPort.onDisconnect.addListener(() => { intercepting = false; interceptPort = null; btn.classList.remove('warn-on'); btn.textContent = '⚡ Intercept'; });
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
  const id = pendingIntercept.requestId;
  if (action === 'resume') interceptPort.postMessage({ type: 'RESUME', requestId: id });
  else if (action === 'modify') {
    let headers; try { headers = JSON.parse(document.getElementById('int-headers').value); } catch { headers = null; }
    interceptPort.postMessage({ type: 'MODIFY', requestId: id, url: document.getElementById('int-url').value, headers, postData: document.getElementById('int-body').value || null });
  } else interceptPort.postMessage({ type: 'BLOCK', requestId: id });
  pendingIntercept = null; closeModal('intercept-modal');
}

// ── Export ─────────────────────────────────────────────────
function exportHAR() {
  const entries = netRequests.map(r => ({
    startedDateTime: new Date(r.ts).toISOString(), time: r.doneAt ? r.doneAt - r.ts : -1,
    request: { method: r.method||'GET', url: r.url, httpVersion:'HTTP/1.1', cookies:[], queryString:[], headersSize:-1, bodySize: r.requestBody?.length||0, headers: hdrs2arr(r.requestHeaders), postData: r.requestBody ? {mimeType:'',text:r.requestBody} : undefined },
    response: { status: r.status||0, statusText: r.statusText||'', httpVersion:'HTTP/1.1', cookies:[], redirectURL:'', headersSize:-1, bodySize: r.size||-1, headers: hdrs2arr(r.responseHeaders), content: {size:r.size||0, mimeType:r.mimeType||'', text:r.responseBody||''} },
    cache:{}, timings:{send:0, wait:r.ttfb||0, receive:0},
  }));
  dl(JSON.stringify({log:{version:'1.2',creator:{name:'AI Inspector',version:'1.0'},entries}},null,2), 'capture.har');
}
function exportJSON() { dl(JSON.stringify({requests:netRequests,console:consoleLogs,websockets:wsConnections},null,2), 'capture.json'); }
function hdrs2arr(h) { return Object.entries(h||{}).map(([name,value])=>({name,value})); }
function dl(text, filename) { const url = URL.createObjectURL(new Blob([text],{type:'application/json'})); Object.assign(document.createElement('a'),{href:url,download:filename}).click(); URL.revokeObjectURL(url); }

// ── REPL ──────────────────────────────────────────────────
async function runRepl() {
  if (!targetTabId) { alert('No tab.'); return; }
  const code = document.getElementById('repl-input').value.trim();
  if (!code) return;
  document.getElementById('repl-input').value = '';
  const out = document.getElementById('repl-out');
  const entry = document.createElement('div'); entry.className = 'repl-entry';
  entry.innerHTML = `<div class="repl-in">${esc(code)}</div>`;
  out.appendChild(entry);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'INS_REPL', tabId: targetTabId, code });
    const d = document.createElement('div'); d.className = r.ok ? 'repl-ok' : 'repl-err';
    d.textContent = r.ok ? r.result : '⚠ ' + r.error; entry.appendChild(d);
    if (r.ok) { lastReplResult = { code, result: r.result }; document.getElementById('repl-ask-btn').disabled = false; }
  } catch(e) { const d = document.createElement('div'); d.className = 'repl-err'; d.textContent = '⚠ ' + e.message; entry.appendChild(d); }
  out.scrollTop = out.scrollHeight;
}

// ── Performance ───────────────────────────────────────────
function updatePerfLive() {
  const active = document.getElementById('panel-performance').classList.contains('active');
  if (active) renderPerfPanel();
}
function renderPerfPanel() {
  const wrap = document.getElementById('perf-wrap');
  const done = netRequests.filter(r => r.done && r.ts);
  if (!done.length) { document.getElementById('perf-empty').style.display=''; return; }
  document.getElementById('perf-empty').style.display = 'none';

  const totalSize = done.reduce((s, r) => s + (r.size || 0), 0);
  const errors = done.filter(r => r.error || (r.status >= 400)).length;
  const slow = done.filter(r => r.ttfb > 1000).length;
  const times = done.filter(r => r.doneAt && r.ts).map(r => r.doneAt - r.ts);
  const avgTime = times.length ? Math.round(times.reduce((a,b)=>a+b,0)/times.length) : 0;

  const byType = {};
  done.forEach(r => { byType[r.type||'Other'] = (byType[r.type||'Other']||0) + 1; });
  const maxType = Math.max(...Object.values(byType), 1);

  const slowest = [...done].filter(r=>r.ttfb!=null).sort((a,b)=>b.ttfb-a.ttfb).slice(0,5);
  const largest = [...done].filter(r=>r.size!=null).sort((a,b)=>b.size-a.size).slice(0,5);

  let tabHost = '';
  try { if (targetTabId) { const url = document.getElementById('tab-url').textContent; tabHost = new URL(url).host; } } catch {}
  const firstParty = tabHost ? done.filter(r => { try { return new URL(r.url).host === tabHost; } catch { return false; } }).length : null;

  wrap.innerHTML = `
    <div class="perf-cards">
      <div class="perf-card"><div class="perf-card-val">${done.length}</div><div class="perf-card-lbl">Requests</div></div>
      <div class="perf-card"><div class="perf-card-val">${fmtSize(totalSize)}</div><div class="perf-card-lbl">Total size</div></div>
      <div class="perf-card"><div class="perf-card-val" style="color:${avgTime>2000?'var(--err)':avgTime>1000?'var(--warn)':'var(--green)'}">${avgTime}ms</div><div class="perf-card-lbl">Avg time</div></div>
      <div class="perf-card"><div class="perf-card-val" style="color:${errors?'var(--err)':'var(--green)'}">${errors}</div><div class="perf-card-lbl">Errors</div></div>
      <div class="perf-card"><div class="perf-card-val" style="color:${slow?'var(--warn)':'var(--green)'}">${slow}</div><div class="perf-card-lbl">&gt;1s</div></div>
      ${firstParty !== null ? `<div class="perf-card"><div class="perf-card-val">${done.length-firstParty}</div><div class="perf-card-lbl">3rd party</div></div>` : ''}
    </div>

    <div class="perf-section">
      <div class="perf-hdr">Slowest Requests (TTFB)</div>
      ${slowest.map(r=>`<div class="perf-row"><span class="perf-url" title="${esc(r.url)}">${esc(shortUrl(r.url))}</span><span class="perf-val" style="color:${r.ttfb>1000?'var(--err)':r.ttfb>500?'var(--warn)':'var(--yellow)'}">${r.ttfb}ms</span></div>`).join('')}
      ${!slowest.length?'<div class="perf-row" style="color:var(--muted)">No timing data yet</div>':''}
    </div>

    <div class="perf-section">
      <div class="perf-hdr">Largest Responses</div>
      ${largest.map(r=>`<div class="perf-row"><span class="perf-url" title="${esc(r.url)}">${esc(shortUrl(r.url))}</span><span class="perf-val">${fmtSize(r.size)}</span></div>`).join('')}
    </div>

    <div class="perf-section">
      <div class="perf-hdr">Requests by Type</div>
      ${Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([type,count])=>`
        <div class="perf-bar-row">
          <div class="perf-bar-lbl"><span>${esc(type||'Other')}</span><span>${count}</span></div>
          <div class="perf-bar-bg"><div class="perf-bar-fill" style="width:${Math.round(count/maxType*100)}%"></div></div>
        </div>`).join('')}
    </div>`;
}
function buildPerfContext() {
  const done = netRequests.filter(r => r.done);
  if (!done.length) return null;
  const slow = done.filter(r=>r.ttfb>1000).map(r=>`${r.ttfb}ms ${r.url}`);
  const large = done.filter(r=>r.size>500000).map(r=>`${fmtSize(r.size)} ${r.url}`);
  const errs = done.filter(r=>r.error||(r.status>=400)).map(r=>`${r.status||'ERR'} ${r.url}`);
  return `Performance data:\n- ${done.length} total requests, ${fmtSize(done.reduce((s,r)=>s+(r.size||0),0))} total\n- Slow (>1s): ${slow.join(', ')||'none'}\n- Large (>500KB): ${large.join(', ')||'none'}\n- Errors: ${errs.join(', ')||'none'}`;
}

// ── Security Audit ────────────────────────────────────────
const SEC_HEADERS = ['content-security-policy','strict-transport-security','x-frame-options','x-content-type-options','referrer-policy','permissions-policy'];

function updateSecLive() { /* auto-update badge only */ }

function runSecurityAudit() {
  const wrap = document.getElementById('sec-wrap');
  const reqs = netRequests.filter(r => r.responseHeaders);
  if (!reqs.length) { alert('No captured requests with response headers yet. Start capture and load a page first.'); return; }
  document.getElementById('sec-empty').style.display = 'none';

  const credInUrl = [], missingHeaders = {}, sensitiveData = [], httpOnHttps = [], corsWildcard = [], mixedContent = [];
  let tabIsHttps = false;
  try { tabIsHttps = document.getElementById('tab-url').textContent.startsWith('https://'); } catch {}

  SEC_HEADERS.forEach(h => { missingHeaders[h] = []; });

  for (const r of reqs) {
    const hdrs = Object.fromEntries(Object.entries(r.responseHeaders).map(([k,v])=>[k.toLowerCase(),v]));
    const url = r.url;

    // Credentials in URL
    if (/[?&](password|passwd|secret|token|apikey|api_key|auth|key)=/i.test(url)) credInUrl.push(url);

    // Missing security headers (check only HTML/JSON responses from same origin)
    const ct = hdrs['content-type'] || '';
    if (ct.includes('text/html')) {
      SEC_HEADERS.forEach(h => { if (!hdrs[h]) missingHeaders[h].push(url); });
    }

    // Sensitive keys in response body
    if (r.responseBody && ct.includes('json')) {
      const body = r.responseBody.toLowerCase();
      if (/(\"password\"|\"secret\"|\"private_key\"|\"client_secret\")/.test(body)) sensitiveData.push(url);
    }

    // CORS wildcard
    if (hdrs['access-control-allow-origin'] === '*') corsWildcard.push(url);

    // HTTP loaded on HTTPS page
    if (tabIsHttps && url.startsWith('http://')) mixedContent.push(url);
  }

  // JWT detection in responses
  const jwtFound = [];
  for (const r of reqs) {
    if (r.responseBody && /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(r.responseBody)) jwtFound.push(r.url);
  }

  const issues = credInUrl.length + sensitiveData.length + corsWildcard.length + mixedContent.length + jwtFound.length;
  const warnings = Object.values(missingHeaders).reduce((s,arr)=>s+(arr.length?1:0),0);
  const score = Math.max(0, 100 - issues*20 - warnings*8);
  const grade = score>=90?'A':score>=75?'B':score>=60?'C':score>=45?'D':'F';

  document.getElementById('sec-badge').textContent = issues + warnings;
  document.getElementById('sec-badge').style.display = issues + warnings ? '' : 'none';

  let html = `<div class="sec-score">
    <div class="sec-grade grade-${grade.toLowerCase()}">${grade}</div>
    <div class="sec-summary"><h4>Security Score: ${score}/100</h4><p>${issues} issue(s), ${warnings} warning(s) from ${reqs.length} responses</p></div>
  </div>`;

  const secIssueRow = (title, detail, fixCtx) =>
    `<div class="sec-issue" style="display:flex;align-items:flex-start;gap:6px">
      <div style="flex:1"><div class="sec-issue-title">${title}</div><div class="sec-issue-detail">${esc(detail)}</div></div>
      <button class="sec-fix-btn" data-fix="${esc(JSON.stringify({title, detail: fixCtx||detail}))}">→ Fix</button>
    </div>`;

  const section = (sectionTitle, items, levelLabel, getDetail) => {
    if (!items.length) return `<div class="perf-section"><div class="sec-hdr">${sectionTitle} <span class="cnt warn">✓ OK</span></div></div>`;
    return `<div class="perf-section"><div class="sec-hdr">${sectionTitle} <span class="cnt">${items.length}</span></div>${items.map(i => secIssueRow(levelLabel, typeof i === 'string' ? i : i.url || '', i)).join('')}</div>`;
  };

  if (credInUrl.length) html += section('⚠ Credentials in URL', credInUrl, 'High — sensitive params exposed in URL');
  if (jwtFound.length) html += section('⚠ JWT Tokens in Responses', jwtFound, 'Medium — JWT tokens found in response bodies');
  if (sensitiveData.length) html += section('⚠ Sensitive Data in Responses', sensitiveData, 'High — password/secret fields found in JSON responses');
  if (corsWildcard.length) html += section('⚠ CORS Wildcard (*)', corsWildcard, 'Medium — Access-Control-Allow-Origin: * allows any origin');
  if (mixedContent.length) html += section('⚠ Mixed Content (HTTP on HTTPS)', mixedContent, 'Medium — HTTP resources on HTTPS page');

  const missingAny = Object.entries(missingHeaders).filter(([,arr])=>arr.length);
  if (missingAny.length) {
    html += `<div class="perf-section"><div class="sec-hdr">Missing Security Headers <span class="cnt warn">${missingAny.length}</span></div>`;
    missingAny.forEach(([h, urls]) => {
      html += secIssueRow(esc(h), `Missing on ${urls.length} page(s)`, `Add header ${h} to responses`);
    });
    html += `</div>`;
  } else {
    html += `<div class="perf-section"><div class="sec-hdr">Security Headers <span class="cnt warn">✓ All present</span></div></div>`;
  }

  wrap.innerHTML = html;
  wrap.querySelectorAll('.sec-fix-btn').forEach(btn => btn.addEventListener('click', () => {
    try { const d = JSON.parse(btn.dataset.fix); generateFix(d.title, d.detail); } catch {}
  }));
}

function buildSecContext() {
  const reqs = netRequests.filter(r => r.responseHeaders);
  if (!reqs.length) return null;
  const lines = [`Security audit of ${reqs.length} captured responses:`];
  for (const r of reqs) {
    const hdrs = Object.fromEntries(Object.entries(r.responseHeaders).map(([k,v])=>[k.toLowerCase(),v]));
    const missing = SEC_HEADERS.filter(h => !hdrs[h]);
    if (missing.length) lines.push(`MISSING HEADERS: ${r.url} — missing: ${missing.join(', ')}`);
    if (/[?&](password|secret|token|key)=/i.test(r.url)) lines.push(`CREDENTIAL IN URL: ${r.url}`);
    if (hdrs['access-control-allow-origin']==='*') lines.push(`CORS WILDCARD: ${r.url}`);
  }
  return lines.join('\n');
}

// ── AI Auto-Scan ──────────────────────────────────────────
async function autoScan() {
  if (!settings.model) { alert('Configure a model in ⚙ settings first.'); return; }
  if (!netRequests.length && !consoleLogs.length) { alert('Nothing captured yet. Start capture and browse the page first.'); return; }

  switchTab('chat'); chatContext = []; chatHistory = [];
  document.getElementById('chat-msgs').innerHTML = '';

  const summary = [
    `=== CAPTURED DATA SUMMARY ===`,
    `Network: ${netRequests.length} requests (${netRequests.filter(r=>r.error||(r.status>=400)).length} errors, ${netRequests.filter(r=>r.ttfb>1000).length} slow)`,
    `Console: ${consoleLogs.length} entries (${consoleLogs.filter(l=>l.level==='error').length} errors, ${consoleLogs.filter(l=>l.level==='warning').length} warnings)`,
    `WebSockets: ${wsConnections.length} connections`,
    ``,
    `=== NETWORK REQUESTS ===`,
    ...netRequests.slice(0, 40).map(r =>
      `${r.method} ${r.url}\n  Status: ${r.status||'pending'} | Size: ${fmtSize(r.size)} | TTFB: ${r.ttfb!=null?r.ttfb+'ms':'?'}${r.error?' | Error: '+r.error:''}${r.responseBody?'\n  Response: '+prettyJSON(r.responseBody).slice(0,500):''}`
    ),
    ``,
    `=== CONSOLE LOGS ===`,
    ...consoleLogs.slice(0, 30).map(l => `[${l.level.toUpperCase()}] ${l.text}${l.url?' ('+shortUrl(l.url)+')':''}`),
  ].join('\n');

  const prompt = `Please analyze this captured browser session and provide a thorough security and performance audit. Specifically:

**Security Issues**: Look for credentials/tokens in URLs, sensitive data in API responses, missing security headers, CORS misconfigurations, HTTP resources on HTTPS pages, exposed JWT tokens, API keys.

**Performance Issues**: Identify slow requests (>1s TTFB), large responses (>500KB), redundant duplicate calls, waterfall blockers.

**Error Analysis**: Explain any HTTP 4xx/5xx errors and console errors. What are they caused by and how to fix them?

**Suspicious Behavior**: Any unusual API calls, data being sent to unexpected domains, or anything that looks like a bug or security concern?

Be specific — reference actual URLs and data from the context.`;

  const userContent = prompt + '\n\n' + summary;
  chatHistory.push({ role: 'user', content: userContent });
  appendChatMsg('user', `🤖 Auto-scanning ${netRequests.length} requests + ${consoleLogs.length} console entries...`);
  setGenerating(true);

  chatPort = chrome.runtime.connect({ name: 'inspector-chat' });
  let assistantContent = '', bubble = null;
  chatPort.onMessage.addListener(msg => {
    if (msg.type === 'CHUNK') { if (!bubble) bubble = appendStreamBubble(); assistantContent += msg.content; renderBubble(bubble, assistantContent); }
    else if (msg.type === 'DONE' || msg.type === 'ERROR') {
      if (msg.type === 'ERROR') appendChatMsg('assistant', `⚠ ${msg.error}`);
      if (assistantContent) chatHistory.push({ role: 'assistant', content: assistantContent });
      setGenerating(false); chatPort = null;
    }
  });
  chatPort.onDisconnect.addListener(() => { if (generating) setGenerating(false); });
  chatPort.postMessage({ type: 'CHAT', payload: { messages: [{ role:'system', content: settings.systemPrompt }, ...chatHistory], settings: { apiBaseUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model } } });
}

// ── AI Fix Generator ──────────────────────────────────────
async function generateFix(title, detail) {
  if (!settings.model) { alert('Configure a model in ⚙ settings first.'); return; }
  switchTab('chat');
  chatContext = []; chatHistory = [];
  document.getElementById('chat-msgs').innerHTML = '';

  const prompt = `I found this security issue in a web application:\n\n**${title}**\nDetail: ${detail}\n\nPlease provide:\n1. A concise explanation of why this is a security risk\n2. A concrete code fix (server-side or client-side as appropriate)\n3. Any additional hardening recommendations\n\nBe specific and provide actual code examples.`;
  chatHistory.push({ role: 'user', content: prompt });
  appendChatMsg('user', `🔐 Generate fix for: ${title}`);
  setGenerating(true);

  chatPort = chrome.runtime.connect({ name: 'inspector-chat' });
  let assistantContent = '', bubble = null;
  chatPort.onMessage.addListener(msg => {
    if (msg.type === 'CHUNK') { if (!bubble) bubble = appendStreamBubble(); assistantContent += msg.content; renderBubble(bubble, assistantContent); }
    else if (msg.type === 'DONE' || msg.type === 'ERROR') {
      if (msg.type === 'ERROR') appendChatMsg('assistant', `⚠ ${msg.error}`);
      if (assistantContent) chatHistory.push({ role: 'assistant', content: assistantContent });
      setGenerating(false); chatPort = null;
    }
  });
  chatPort.onDisconnect.addListener(() => { if (generating) setGenerating(false); });
  chatPort.postMessage({ type: 'CHAT', payload: { messages: [{ role:'system', content: settings.systemPrompt }, ...chatHistory], settings: { apiBaseUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model } } });
}

// ── GraphQL helpers ───────────────────────────────────────
function isGraphQL(r) {
  if (!r.requestBody) return false;
  try { const b = JSON.parse(r.requestBody); return typeof b.query === 'string'; } catch { return false; }
}
function renderGraphQL(r) {
  try {
    const req = JSON.parse(r.requestBody);
    const respObj = r.responseBody ? JSON.parse(r.responseBody) : null;
    let html = `<div class="gql-tree">`;
    html += `<div><span class="gql-op">Operation:</span> ${esc(req.operationName || '(anonymous)')}</div>`;
    if (req.variables && Object.keys(req.variables).length) html += `<div><span class="gql-key">Variables:</span> <span class="gql-val">${esc(JSON.stringify(req.variables,null,2))}</span></div>`;
    html += `<div style="margin-top:6px"><span class="gql-key">Query:</span><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-all">${esc(req.query)}</pre></div>`;
    if (respObj?.data) html += `<div style="margin-top:6px"><span class="gql-key">Response data keys:</span> <span class="gql-val">${esc(Object.keys(respObj.data).join(', '))}</span></div>`;
    if (respObj?.errors) html += `<div style="margin-top:4px;color:var(--err)"><span>Errors: ${esc(JSON.stringify(respObj.errors))}</span></div>`;
    html += `</div>`;
    return html;
  } catch { return esc(r.requestBody||''); }
}

// ── Network render ────────────────────────────────────────
function visibleReqs() {
  const gs = globalSearch;
  return netRequests.filter(r => {
    if (filterText && !r.url.toLowerCase().includes(filterText)) return false;
    if (filterMethod && r.method !== filterMethod) return false;
    if (filterType && !r.type.toLowerCase().includes(filterType)) return false;
    if (gs && !r.url.toLowerCase().includes(gs) && !(r.responseBody||'').toLowerCase().includes(gs)) return false;
    return true;
  });
}
function renderNetwork() {
  const tbody = document.getElementById('net-tbody'), empty = document.getElementById('net-empty');
  const visible = visibleReqs();
  if (!netRequests.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  const maxMs = Math.max(...visible.filter(r=>r.ttfb!=null).map(r=>r.ttfb), 1);
  const rows = [];
  for (const r of visible) {
    const chk = selectedRequests.has(r.id), exp = expandedRow === r.id;
    const sc = r.error?'serr':r.status?`s${Math.floor(r.status/100)}`:'';
    const mc = `m${(r.method||'').slice(0,1).toLowerCase()}`;
    const ms = r.ttfb ?? (r.doneAt&&r.ts ? r.doneAt-r.ts : null);
    const pct = ms!=null ? Math.max(2,Math.round(ms/maxMs*100)) : 0;
    const timeCell = ms!=null ? `<div class="wf-w"><div class="wf-bg"><div class="wf-bar" style="width:${pct}%"></div></div><span class="wf-ms">${ms}ms</span></div>` : '<span class="wf-ms">…</span>';
    rows.push(`<tr data-id="${esc(r.id)}" class="${chk?'sel':''} ${exp?'expanded':''}">
      <td class="chk"><input type="checkbox" ${chk?'checked':''} data-id="${esc(r.id)}"></td>
      <td class="met ${mc}">${esc(r.method||'')}</td>
      <td class="sta ${sc}">${r.error?'ERR':(r.status||'…')}</td>
      <td class="typ">${esc(r.type||'')}</td>
      <td class="siz">${r.size!=null?fmtSize(r.size):'…'}</td>
      <td class="tim">${timeCell}</td>
      <td class="url-c" title="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\/[^/]+/,'') || '/')}</td>
    </tr>`);
    if (exp) {
      const gql = isGraphQL(r);
      const tabs = ['response-body','request-body','req-headers','res-headers'];
      if (gql) tabs.splice(1, 0, 'graphql');
      const tabLabels = {'response-body':'Response','request-body':'Req Body','req-headers':'Req Headers','res-headers':'Res Headers','graphql':'GraphQL'};
      rows.push(`<tr class="det-row"><td colspan="7"><div class="det-pane">
        <div class="det-tabs">
          ${tabs.map(t=>`<div class="d-t ${expandedDTab===t?'active':''}" data-dt="${t}" data-id="${esc(r.id)}">${tabLabels[t]}${t==='graphql'?'<span class="gql-badge">GQL</span>':''}</div>`).join('')}
          <button class="d-curl" data-cid="${esc(r.id)}">Copy cURL</button>
          <button class="d-curl" data-rpid="${esc(r.id)}" style="margin-left:2px">↺ Replay</button>
        </div>
        <div class="det-c">${getDetContent(r, expandedDTab)}</div>
      </div></td></tr>`);
    }
  }
  tbody.innerHTML = rows.join('');
  tbody.querySelectorAll('input[data-id]').forEach(cb => cb.addEventListener('change', e => { e.stopPropagation(); if(cb.checked) selectedRequests.add(cb.dataset.id); else selectedRequests.delete(cb.dataset.id); cb.closest('tr').classList.toggle('sel',cb.checked); updateSelCount(); }));
  tbody.querySelectorAll('tr[data-id]').forEach(row => row.addEventListener('click', e => { if(e.target.tagName==='INPUT'||e.target.classList.contains('d-t')||e.target.classList.contains('d-curl')) return; const id=row.dataset.id; expandedRow=expandedRow===id?null:id; renderNetwork(); }));
  tbody.querySelectorAll('.d-t').forEach(dt => dt.addEventListener('click', e => { e.stopPropagation(); expandedDTab=dt.dataset.dt; renderNetwork(); }));
  tbody.querySelectorAll('.d-curl[data-cid]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const r=netRequests.find(x=>x.id===btn.dataset.cid); if(r){navigator.clipboard.writeText(buildCurl(r));btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy cURL',1500);} }));
  tbody.querySelectorAll('.d-curl[data-rpid]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); const r=netRequests.find(x=>x.id===btn.dataset.rpid); if(r) openReplayModal(r); }));
}
function getDetContent(r, tab) {
  if (tab==='response-body') { if(r.error) return esc('Error: '+r.error); if(!r.done) return '…'; if(!r.responseBody) return '(empty)'; return esc(prettyJSON(r.responseBody)); }
  if (tab==='request-body') return r.requestBody ? esc(prettyJSON(r.requestBody)) : '(no body)';
  if (tab==='req-headers') return r.requestHeaders ? esc(Object.entries(r.requestHeaders).map(([k,v])=>`${k}: ${v}`).join('\n')) : '(none)';
  if (tab==='res-headers') return r.responseHeaders ? esc(Object.entries(r.responseHeaders).map(([k,v])=>`${k}: ${v}`).join('\n')) : '(none)';
  if (tab==='graphql') return renderGraphQL(r);
  return '';
}
function buildCurl(r) {
  let c = `curl -X ${r.method} '${r.url}'`;
  for (const [k,v] of Object.entries(r.requestHeaders||{})) { if(k.toLowerCase()==='content-length') continue; c += `\\\n  -H '${k}: ${v.replace(/'/g,"\\'")}'`; }
  if (r.requestBody) c += `\\\n  --data-raw '${r.requestBody.replace(/'/g,"\\'")}'`;
  return c;
}
function updateSelCount() { const c=selectedRequests.size; document.getElementById('sel-count').textContent=c?`${c} selected`:''; document.getElementById('ask-net-btn').disabled=!c; }

// ── Console render ────────────────────────────────────────
function renderConsole() {
  const list = document.getElementById('con-list'), empty = document.getElementById('con-empty');
  const gs = globalSearch;
  const vis = consoleLogs.filter(l => { if(filterLevel&&l.level!==filterLevel) return false; if(filterConText&&!l.text.toLowerCase().includes(filterConText)) return false; if(gs&&!l.text.toLowerCase().includes(gs)) return false; return true; });
  if (!consoleLogs.length) { list.innerHTML=''; list.appendChild(empty); empty.style.display=''; return; }
  empty.style.display='none';
  const icons = {error:'✖',warning:'⚠',info:'ℹ',log:'›',debug:'›'};

  if (consoleGrouped) {
    // Group by text
    const groups = new Map();
    vis.forEach((l, i) => {
      const key = l.level + '::' + l.text;
      if (!groups.has(key)) groups.set(key, { log: l, indices: [], count: 0 });
      groups.get(key).indices.push(i);
      groups.get(key).count++;
    });
    const html = [...groups.entries()].map(([key, g]) => {
      const l = g.log, isOpen = expandedGroups.has(key);
      const subItems = isOpen ? g.indices.map(i => { const ll = vis[i]; return `<div class="log-e ${esc(ll.level)}" style="border-left:none;padding-left:4px"><span class="log-icon" style="opacity:.4">${icons[ll.level]||'›'}</span><span class="log-txt">${esc(ll.text)}</span>${ll.url?`<span class="log-src">${esc(shortUrl(ll.url))}${ll.line?':'+ll.line:''}</span>`:''}</div>`; }).join('') : '';
      return `<div>
        <div class="log-group-hdr log-e ${esc(l.level)}" data-gkey="${esc(key)}">
          <input type="checkbox" data-gkey="${esc(key)}" style="flex-shrink:0">
          <span class="log-icon">${icons[l.level]||'›'}</span>
          <span class="log-txt">${esc(l.text)}</span>
          ${g.count>1?`<span class="log-group-cnt">${g.count}</span>`:''}
          ${l.url?`<span class="log-src">${esc(shortUrl(l.url))}</span>`:''}
          <span style="color:var(--muted);font-size:10px;margin-left:auto">${isOpen?'▲':'▼'}</span>
        </div>
        ${isOpen?`<div class="log-group-body">${subItems}</div>`:''}
      </div>`;
    }).join('');
    list.innerHTML = html;
    list.querySelectorAll('.log-group-hdr').forEach(hdr => hdr.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      const key = hdr.dataset.gkey;
      if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
      renderConsole();
    }));
    list.querySelectorAll('input[data-gkey]').forEach(cb => cb.addEventListener('change', e => {
      e.stopPropagation();
      const g = [...groups.values()].find(g => (g.log.level + '::' + g.log.text) === cb.dataset.gkey);
      if (g) { if (cb.checked) g.indices.forEach(i => selectedLogs.add(i)); else g.indices.forEach(i => selectedLogs.delete(i)); }
      updateConSel();
    }));
  } else {
    list.innerHTML = vis.map((l,i) => `<div class="log-e ${esc(l.level)} ${selectedLogs.has(i)?'sel':''}" data-idx="${i}">
      <input type="checkbox" ${selectedLogs.has(i)?'checked':''} data-idx="${i}" style="flex-shrink:0;margin-top:2px">
      <span class="log-icon">${icons[l.level]||'›'}</span>
      <span class="log-txt">${esc(l.text)}</span>
      ${l.url?`<span class="log-src">${esc(shortUrl(l.url))}${l.line?':'+l.line:''}</span>`:''}
    </div>`).join('');
    list.querySelectorAll('input[data-idx]').forEach(cb => cb.addEventListener('change', e => { e.stopPropagation(); const i=parseInt(cb.dataset.idx); if(cb.checked) selectedLogs.add(i); else selectedLogs.delete(i); updateConSel(); }));
  }
  updateConSel();
}
function updateConSel() { const c=selectedLogs.size; document.getElementById('con-sel-count').textContent=c?`${c} selected`:''; document.getElementById('ask-con-btn').disabled=!c; }

// ── WebSockets render ─────────────────────────────────────
function renderWebSockets() {
  const list = document.getElementById('ws-list'), empty = document.getElementById('ws-empty');
  const gs = globalSearch, fu = document.getElementById('ws-filter').value.toLowerCase(), fd = document.getElementById('ws-dir-filter').value;
  const conns = wsConnections.filter(c => (!fu||c.url.toLowerCase().includes(fu)) && (!gs||c.url.toLowerCase().includes(gs)||c.frames.some(f=>f.data.toLowerCase().includes(gs))));
  if (!wsConnections.length) { list.innerHTML=''; empty.style.display=''; return; }
  empty.style.display='none';
  list.innerHTML = conns.map(conn => {
    const isOpen = expandedWsConn === conn.id;
    const frames = conn.frames.filter(f => !fd||f.dir===fd);
    const frHtml = frames.map((f,fi) => { const sel=selectedWsFrames.some(s=>s.connId===conn.id&&s.frameIdx===fi); return `<div class="ws-frame"><input type="checkbox" data-cid="${esc(conn.id)}" data-fi="${fi}" ${sel?'checked':''}><span class="ws-dir ${f.dir}">${f.dir==='sent'?'↑':'↓'}</span><div class="ws-data">${esc(tryPrettyWs(f.data))}</div><span class="ws-ts">${fmtTime(f.ts)}</span></div>`; }).join('');
    return `<div class="ws-conn ${isOpen?'open':''}" data-id="${esc(conn.id)}"><div class="ws-hdr"><div class="ws-dot ${conn.closed?'closed':''}"></div><span class="ws-url" title="${esc(conn.url)}">${esc(conn.url)}</span><span class="ws-meta">${conn.frames.length} frames ${conn.closed?'· closed':'· open'}</span></div><div class="ws-frames">${frHtml||'<div style="color:var(--muted);font-size:11px;padding:4px">No frames</div>'}</div></div>`;
  }).join('');
  list.querySelectorAll('.ws-hdr').forEach(h => h.addEventListener('click', () => { const id=h.closest('.ws-conn').dataset.id; expandedWsConn=expandedWsConn===id?null:id; renderWebSockets(); }));
  list.querySelectorAll('input[data-cid]').forEach(cb => cb.addEventListener('change', e => { e.stopPropagation(); const cid=cb.dataset.cid,fi=parseInt(cb.dataset.fi); if(cb.checked) selectedWsFrames.push({connId:cid,frameIdx:fi}); else selectedWsFrames=selectedWsFrames.filter(s=>!(s.connId===cid&&s.frameIdx===fi)); updateWsSel(); }));
  updateWsSel();
}
function tryPrettyWs(d) { try { return JSON.stringify(JSON.parse(d),null,2); } catch { return d; } }
function fmtTime(ts) { const d=new Date(ts); return d.toTimeString().slice(0,8)+'.'+String(d.getMilliseconds()).padStart(3,'0'); }
function updateWsSel() { const c=selectedWsFrames.length; document.getElementById('ws-sel-count').textContent=c?`${c} selected`:''; document.getElementById('ask-ws-btn').disabled=!c; }

// ── Storage ───────────────────────────────────────────────
async function refreshStorage() {
  if (!targetTabId) return;
  const btn = document.getElementById('stor-refresh-btn'); btn.textContent='⏳'; btn.disabled=true;
  try {
    if (storageType==='cookies') {
      const r = await chrome.runtime.sendMessage({type:'INS_COOKIES',tabId:targetTabId});
      storageItems = r.ok ? r.cookies.map(c=>({key:c.name,value:JSON.stringify({value:c.value,domain:c.domain,path:c.path,httpOnly:c.httpOnly,secure:c.secure})})) : [{key:'Error',value:r.error}];
    } else {
      const r = await chrome.runtime.sendMessage({type:'INS_STORAGE',tabId:targetTabId});
      storageItems = r.ok ? (storageType==='local'?r.storage.local:r.storage.session).map(([k,v])=>({key:k,value:v})) : [{key:'Error',value:r.error}];
    }
    selectedStorItems.clear(); renderStorage();
  } finally { btn.textContent='↻ Refresh'; btn.disabled=false; }
}
function visibleStorItems() { const f=document.getElementById('stor-filter').value.toLowerCase(); return storageItems.filter(i=>!f||i.key.toLowerCase().includes(f)||i.value.toLowerCase().includes(f)); }
function renderStorage() {
  const tbody=document.getElementById('stor-tbody'), empty=document.getElementById('stor-empty');
  const vis=visibleStorItems();
  if (!storageItems.length) { tbody.innerHTML=''; empty.style.display=''; return; }
  empty.style.display='none';
  tbody.innerHTML = vis.map((item,i) => `<tr class="${selectedStorItems.has(i)?'sel':''}" data-idx="${i}"><td style="text-align:center"><input type="checkbox" data-idx="${i}" ${selectedStorItems.has(i)?'checked':''}></td><td title="${esc(item.key)}">${esc(item.key)}</td><td title="${esc(item.value)}">${esc(item.value.slice(0,200))}</td></tr>`).join('');
  tbody.querySelectorAll('input[data-idx]').forEach(cb => cb.addEventListener('change', e => { e.stopPropagation(); const i=parseInt(cb.dataset.idx); if(cb.checked) selectedStorItems.add(i); else selectedStorItems.delete(i); cb.closest('tr').classList.toggle('sel',cb.checked); updateStorSel(); }));
  updateStorSel();
}
function updateStorSel() { const c=selectedStorItems.size; document.getElementById('stor-sel-count').textContent=c?`${c} selected`:''; document.getElementById('ask-stor-btn').disabled=!c; }

// ── Badges ────────────────────────────────────────────────
function updateBadges() {
  const nb=document.getElementById('net-badge'), cb=document.getElementById('con-badge'), wb=document.getElementById('ws-badge');
  if(netRequests.length){nb.textContent=netRequests.length;nb.style.display='';}else nb.style.display='none';
  const ec=consoleLogs.filter(l=>l.level==='error').length;
  if(ec){cb.textContent=ec;cb.style.display='';}else if(consoleLogs.length){cb.textContent=consoleLogs.length;cb.style.display='';}else cb.style.display='none';
  const wt=wsConnections.reduce((s,c)=>s+c.frames.length,0);
  if(wt){wb.textContent=wt;wb.style.display='';}else wb.style.display='none';
}

// ── Tab switch ────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
  if (name==='performance') renderPerfPanel();
}

// ── Send to Chat ──────────────────────────────────────────
function sendToChat(source) {
  chatContext = [];
  if (source==='network') { for(const id of selectedRequests){const r=netRequests.find(x=>x.id===id);if(r)chatContext.push({type:'request',data:r});} }
  else if (source==='console') { for(const i of selectedLogs){const l=consoleLogs[i];if(l)chatContext.push({type:'log',data:l});} }
  else if (source==='websockets') { for(const {connId,frameIdx} of selectedWsFrames){const conn=wsConnections.find(c=>c.id===connId);const f=conn?.frames[frameIdx];if(f)chatContext.push({type:'wsframe',data:{url:conn.url,...f}});} }
  else if (source==='storage') { const vis=visibleStorItems(); for(const i of selectedStorItems){const item=vis[i];if(item)chatContext.push({type:'storage',data:{storageType,...item}});} }
  renderCtxBar(); switchTab('chat');
}

function renderCtxBar() {
  const bar = document.getElementById('chat-ctx-bar');
  if (!chatContext.length) { bar.style.display='none'; bar.innerHTML=''; return; }
  bar.style.display='flex';
  bar.innerHTML = chatContext.map((c,i) => {
    const lbl = c.type==='request'?`${c.data.method} ${shortUrl(c.data.url)} (${c.data.status||'…'})`
      :c.type==='dom'?`DOM (${fmtSize(c.data.size)})`
      :c.type==='screenshot'?`Screenshot`
      :c.type==='wsframe'?`WS ${c.data.dir==='sent'?'↑':'↓'} ${c.data.data.slice(0,25)}`
      :c.type==='storage'?`${c.data.storageType}: ${c.data.key}`
      :c.type==='repl'?`REPL: ${c.data.code.slice(0,25)}`
      :c.type==='replay'?`Replay: ${c.data.status}`
      :c.type==='perf'?`Performance report`
      :c.type==='security'?`Security audit`
      :`[${c.data.level}] ${c.data.text.slice(0,35)}`;
    return `<div class="ctx-chip">📎 ${esc(lbl)} <span class="rm" data-i="${i}">✕</span></div>`;
  }).join('');
  bar.querySelectorAll('.rm').forEach(btn=>btn.addEventListener('click',()=>{chatContext.splice(parseInt(btn.dataset.i),1);renderCtxBar();}));
}

function buildCtxBlock() {
  if (!chatContext.length) return '';
  const parts = chatContext.map(c => {
    if(c.type==='request'){const r=c.data;return['=== Network Request ===',`${r.method} ${r.url}`,`Status: ${r.status||'pending'} ${r.statusText||''}`,r.requestBody?`Request Body:\n${prettyJSON(r.requestBody)}`:'',r.responseBody?`Response Body:\n${prettyJSON(r.responseBody).slice(0,8000)}`:'',r.error?`Error: ${r.error}`:''].filter(Boolean).join('\n');}
    if(c.type==='log'){const l=c.data;return `=== Console [${l.level.toUpperCase()}] ===\n${l.text}${l.url?`\nat ${l.url}${l.line?':'+l.line:''}`:''}`;}
    if(c.type==='dom') return `=== Page DOM (${fmtSize(c.data.size)}) ===\n${c.data.html.slice(0,60000)}`;
    if(c.type==='screenshot') return `=== Page Screenshot ===\n[PNG image attached]`;
    if(c.type==='wsframe'){const f=c.data;return `=== WebSocket [${f.dir.toUpperCase()}] ===\nURL: ${f.url}\n${tryPrettyWs(f.data)}`;}
    if(c.type==='storage') return `=== ${c.data.storageType} ===\n${c.data.key}: ${c.data.value}`;
    if(c.type==='repl') return `=== JS REPL ===\n> ${c.data.code}\n${c.data.result}`;
    if(c.type==='perf') return c.data.text;
    if(c.type==='security') return c.data.text;
    if(c.type==='replay'){const r=c.data;return `=== Replayed Response ===\nStatus: ${r.status} ${r.statusText}\nBody:\n${prettyJSON(r.body||'').slice(0,8000)}`;}
    return '';
  });
  return `\n\n[CONTEXT]\n${parts.filter(Boolean).join('\n\n---\n\n')}`;
}

// ── Chat ──────────────────────────────────────────────────
async function sendChat() {
  const prompt = document.getElementById('chat-prompt').value.trim();
  if (!prompt||generating) return;
  if (!settings.model) { alert('Configure a model in ⚙ settings first.'); return; }
  document.getElementById('chat-prompt').value=''; autoResize();
  const ctx = buildCtxBlock();
  chatHistory.push({role:'user',content:prompt+ctx});
  appendChatMsg('user', prompt+(chatContext.length?`\n📎 ${chatContext.length} attached`:''));
  chatContext=[]; renderCtxBar(); setGenerating(true);
  const messages=[{role:'system',content:settings.systemPrompt},...chatHistory];
  let ac='', bubble=null;
  chatPort = chrome.runtime.connect({name:'inspector-chat'});
  chatPort.onMessage.addListener(msg=>{
    if(msg.type==='CHUNK'){if(!bubble)bubble=appendStreamBubble();ac+=msg.content;renderBubble(bubble,ac);}
    else if(msg.type==='DONE'||msg.type==='ERROR'){if(msg.type==='ERROR')appendChatMsg('assistant','⚠ '+msg.error);if(ac)chatHistory.push({role:'assistant',content:ac});setGenerating(false);chatPort=null;}
  });
  chatPort.onDisconnect.addListener(()=>{if(generating)setGenerating(false);});
  chatPort.postMessage({type:'CHAT',payload:{messages,settings:{apiBaseUrl:settings.apiUrl,apiKey:settings.apiKey,model:settings.model}}});
  scrollChat();
}
function stopChat(){if(chatPort){chatPort.disconnect();chatPort=null;}setGenerating(false);}
function setGenerating(v){
  generating=v;
  document.getElementById('chat-send').disabled=v;
  document.getElementById('chat-prompt').disabled=v;
  document.getElementById('chat-stop').classList.toggle('vis',v);
  document.getElementById('typing-indicator')?.remove();
  if(v){const el=document.createElement('div');el.id='typing-indicator';el.className='cmsg assistant';el.innerHTML='<div class="cmsg-role">AI</div><div class="typing-dots"><span></span><span></span><span></span></div>';document.getElementById('chat-msgs').appendChild(el);scrollChat();}
}
function appendChatMsg(role,content){const msgs=document.getElementById('chat-msgs');const d=document.createElement('div');d.className=`cmsg ${role}`;d.innerHTML=`<div class="cmsg-role">${role==='user'?'You':'AI'}</div><div class="cmsg-bubble">${renderContent(content)}</div>`;msgs.appendChild(d);scrollChat();}
function appendStreamBubble(){document.getElementById('typing-indicator')?.remove();const msgs=document.getElementById('chat-msgs');const d=document.createElement('div');d.className='cmsg assistant';d.innerHTML='<div class="cmsg-role">AI</div><div class="cmsg-bubble"></div>';msgs.appendChild(d);scrollChat();return d.querySelector('.cmsg-bubble');}
function renderBubble(el,text){el.innerHTML=renderContent(text);scrollChat();}
function renderContent(text){
  let html='';
  for(const part of text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)){
    if(part.startsWith('```')){const m=part.match(/^```(\w*)\n?([\s\S]*?)```$/);const lang=m?.[1]||'';const code=m?.[2]||part.slice(3,-3);html+=`<div class="code-block"><div class="code-hdr"><span>${esc(lang)}</span><button class="code-cp" onclick="cpCode(this)">Copy</button></div><pre>${esc(code)}</pre></div>`;}
    else if(part.startsWith('`')&&part.endsWith('`')){html+=`<code style="background:var(--surface2);padding:1px 4px;border-radius:3px;font-family:monospace">${esc(part.slice(1,-1))}</code>`;}
    else{html+=esc(part).replace(/\n/g,'<br>');}
  }
  return html;
}
function scrollChat(){requestAnimationFrame(()=>{const m=document.getElementById('chat-msgs');m.scrollTop=m.scrollHeight;});}
function autoResize(){const el=document.getElementById('chat-prompt');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}

// ── Settings ──────────────────────────────────────────────
function populateSettingsForm(){document.getElementById('s-url').value=settings.apiUrl;document.getElementById('s-model').value=settings.model;document.getElementById('s-key').value=settings.apiKey;document.getElementById('s-sysprompt').value=settings.systemPrompt;}
async function saveSettingsFromForm(){settings.apiUrl=document.getElementById('s-url').value.replace(/\/$/,'');settings.model=document.getElementById('s-model').value.trim();settings.apiKey=document.getElementById('s-key').value.trim();settings.systemPrompt=document.getElementById('s-sysprompt').value;await saveSettings();closeModal('settings-modal');}

// ── Modal helpers ─────────────────────────────────────────
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}

// ── Helpers ───────────────────────────────────────────────
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function shortUrl(url){try{const u=new URL(url);return u.pathname+(u.search||'');}catch{return url;}}
function fmtSize(b){if(!b)return'0B';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function prettyJSON(t){try{return JSON.stringify(JSON.parse(t),null,2);}catch{return t;}}
window.cpCode=function(btn){const code=btn.closest('.code-block')?.querySelector('pre')?.textContent||'';navigator.clipboard.writeText(code);btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500);};

// ── Start ─────────────────────────────────────────────────
init();
