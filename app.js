/* =====================================================================
   ZAWA Console — app.js
   Dashboard testing untuk ZAWA WhatsApp API.
   Semua data session disimpan di localStorage browser kamu sendiri.
   ===================================================================== */

const STORAGE_KEY = 'zawa_sessions_v1';
const BASEURL_KEY = 'zawa_base_url_v1';

/* ---------------------------------------------------------------------
   State
   --------------------------------------------------------------------- */
let state = {
  sessions: [],       // [{ localId, id, sessionId, name, isConnected, qrcode, picture, createdAt, groups: [] }]
  activeLocalId: null,
};

let autoRefreshTimer = null;

/* ---------------------------------------------------------------------
   Storage helpers
   --------------------------------------------------------------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.sessions)) state.sessions = parsed.sessions;
      if (parsed.activeLocalId) state.activeLocalId = parsed.activeLocalId;
    }
  } catch (e) {
    console.error('Gagal load data dari localStorage:', e);
  }

  const savedBaseUrl = localStorage.getItem(BASEURL_KEY);
  if (savedBaseUrl) {
    document.getElementById('baseUrlInput').value = savedBaseUrl;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessions: state.sessions,
      activeLocalId: state.activeLocalId,
    }));
  } catch (e) {
    console.error('Gagal simpan data ke localStorage:', e);
    showToast('Gagal simpan ke localStorage (mungkin penuh)', 'error');
  }
}

function getBaseUrl() {
  const v = document.getElementById('baseUrlInput').value.trim();
  return v.replace(/\/+$/, '');
}

/* ---------------------------------------------------------------------
   Session helpers
   --------------------------------------------------------------------- */
function getActiveSession() {
  return state.sessions.find(s => s.localId === state.activeLocalId) || null;
}

function genLocalId() {
  return 'loc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function upsertActiveSessionFields(fields) {
  const s = getActiveSession();
  if (!s) return;
  Object.assign(s, fields);
  saveState();
  renderSessionList();
  renderActiveSessionTopbar();
}

/* ---------------------------------------------------------------------
   API call wrapper (also logs to the request log drawer)
   --------------------------------------------------------------------- */
async function callApi({ method, path, headers = {}, body = null }) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    showToast('Base URL belum diisi', 'error');
    throw new Error('Base URL kosong');
  }

  // Mode proxy: kalau base URL mengandung "/api/proxy" (proxy Vercel kita),
  // request beneran dikirim ke base URL itu sendiri dengan path ZAWA
  // diselipkan sebagai query param ?path=..., bukan langsung digabung.
  // Ini supaya proxy Vercel tau endpoint ZAWA mana yang mau dipanggil.
  const isProxyMode = baseUrl.includes('/api/proxy');
  const url = isProxyMode
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}path=${encodeURIComponent(path)}`
    : baseUrl + path;

  const logId = addLogEntry({
    method,
    url,
    requestHeaders: headers,
    requestBody: body,
    status: 'pending',
  });

  const fetchOpts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== null) fetchOpts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, fetchOpts);
    let data = null;
    let rawText = '';
    try {
      rawText = await res.text();
      data = rawText ? JSON.parse(rawText) : null;
    } catch (e) {
      data = rawText;
    }

    updateLogEntry(logId, {
      status: res.ok ? 'ok' : 'err',
      httpStatus: res.status,
      responseBody: data,
    });

    if (!res.ok) {
      const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.httpStatus = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (e) {
    if (e.httpStatus === undefined) {
      // network-level failure (CORS, offline, dll)
      updateLogEntry(logId, {
        status: 'err',
        httpStatus: 0,
        responseBody: { message: 'Network error / CORS / server tidak bisa diakses: ' + e.message },
      });
    }
    throw e;
  }
}

function authHeaders(session) {
  return {
    'id': session.id,
    'session-id': session.sessionId,
  };
}

/* =====================================================================
   SESSION API
   ===================================================================== */

async function createNewSession() {
  try {
    const data = await callApi({ method: 'POST', path: '/session' });
    const newSession = {
      localId: genLocalId(),
      id: data.id,
      sessionId: data.sessionId,
      name: null,
      isConnected: false,
      qrcode: null,
      picture: null,
      createdAt: Date.now(),
      groups: [],
    };
    state.sessions.push(newSession);
    state.activeLocalId = newSession.localId;
    saveState();
    renderSessionList();
    renderActiveSessionTopbar();
    showToast('Session baru berhasil dibuat', 'success');
    // langsung ambil info/QR
    await fetchSessionInfo();
  } catch (e) {
    showToast('Gagal buat session: ' + e.message, 'error');
  }
}

async function fetchSessionInfo() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  try {
    const data = await callApi({
      method: 'GET',
      path: '/session',
      headers: authHeaders(s),
    });
    upsertActiveSessionFields({
      name: data.name || s.name,
      isConnected: !!data.isConnected,
      qrcode: data.qrcode || null,
      picture: data.picture || null,
    });
    renderSessionPanel();

    if (data.isConnected) {
      showToast('WhatsApp terhubung!', 'success');
      stopAutoRefresh();
      document.getElementById('toggleAutoRefresh').checked = false;
    }
  } catch (e) {
    showToast('Gagal ambil session: ' + e.message, 'error');
  }
}

async function resetSession() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  try {
    await callApi({ method: 'PUT', path: '/session', headers: authHeaders(s) });
    upsertActiveSessionFields({ isConnected: false, qrcode: null, picture: null, name: null });
    renderSessionPanel();
    showToast('Session berhasil di-reset', 'success');
  } catch (e) {
    showToast('Gagal reset session: ' + e.message, 'error');
  }
}

function deleteSessionFlow() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  showConfirmModal({
    title: 'Hapus Session?',
    body: `Ini bakal hapus session "${s.name || s.id}" dari server ZAWA dan dari daftar lokal kamu. Aksi ini ngga bisa dibatalin.`,
    onConfirm: async () => {
      try {
        await callApi({ method: 'DELETE', path: '/session', headers: authHeaders(s) });
        showToast('Session berhasil dihapus dari server', 'success');
      } catch (e) {
        showToast('Server gagal hapus session (' + e.message + '), tapi tetap dihapus dari daftar lokal', 'warn');
      }
      removeSessionLocally(s.localId);
    }
  });
}

function removeSessionLocally(localId) {
  state.sessions = state.sessions.filter(s => s.localId !== localId);
  if (state.activeLocalId === localId) {
    state.activeLocalId = state.sessions.length ? state.sessions[0].localId : null;
  }
  saveState();
  renderSessionList();
  renderActiveSessionTopbar();
  renderSessionPanel();
  renderGroupList();
}

/* =====================================================================
   MESSAGE API
   ===================================================================== */

function buildMessagePayload() {
  const target = document.querySelector('input[name="msgTarget"]:checked').value;
  const type = document.getElementById('msgType').value;

  const payload = { type };
  if (target === 'phone') {
    payload.phone = document.getElementById('msgPhone').value.trim();
  } else {
    payload.group = document.getElementById('msgGroup').value.trim();
  }

  if (['text', 'image', 'video', 'document'].includes(type)) {
    payload.text = document.getElementById('msgText').value;
  }

  if (type === 'image') {
    payload.image = {
      url: document.getElementById('msgImageUrl').value.trim(),
      mimetype: document.getElementById('msgImageMime').value.trim() || 'image/jpeg',
    };
  } else if (type === 'video') {
    payload.video = {
      url: document.getElementById('msgVideoUrl').value.trim(),
      mimetype: document.getElementById('msgVideoMime').value.trim() || 'video/mp4',
      duration: Number(document.getElementById('msgVideoDuration').value) || undefined,
    };
  } else if (type === 'audio') {
    payload.audio = {
      url: document.getElementById('msgAudioUrl').value.trim(),
      mimetype: document.getElementById('msgAudioMime').value.trim() || 'audio/mpeg',
      duration: Number(document.getElementById('msgAudioDuration').value) || undefined,
    };
  } else if (type === 'document') {
    payload.document = {
      url: document.getElementById('msgDocUrl').value.trim(),
      name: document.getElementById('msgDocName').value.trim(),
      mimetype: document.getElementById('msgDocMime').value.trim() || 'application/pdf',
      size: Number(document.getElementById('msgDocSize').value) || undefined,
    };
  } else if (type === 'location') {
    payload.location = {
      name: document.getElementById('msgLocName').value.trim(),
      address: document.getElementById('msgLocAddress').value.trim(),
      latitude: Number(document.getElementById('msgLocLat').value) || undefined,
      longitude: Number(document.getElementById('msgLocLng').value) || undefined,
    };
  } else if (type === 'contact') {
    payload.contact = {
      name: document.getElementById('msgContactName').value.trim(),
      phone: document.getElementById('msgContactPhone').value.trim(),
    };
  }

  return payload;
}

function updateMessagePayloadPreview() {
  const payload = buildMessagePayload();
  document.getElementById('msgPayloadPreview').textContent = JSON.stringify(payload, null, 2);
}

async function sendMessage() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  const payload = buildMessagePayload();
  try {
    const data = await callApi({
      method: 'POST',
      path: '/message',
      headers: authHeaders(s),
      body: payload,
    });
    showToast('Pesan terkirim! messageId: ' + (data.messageId || '-'), 'success');
  } catch (e) {
    showToast('Gagal kirim pesan: ' + e.message, 'error');
  }
}

/* =====================================================================
   STATUS API
   ===================================================================== */

function buildStatusPayload() {
  const type = document.getElementById('statusType').value;
  const payload = { type };

  if (type === 'text') {
    payload.text = document.getElementById('statusText').value;
  } else if (type === 'image') {
    payload.text = document.getElementById('statusText').value;
    payload.image = {
      url: document.getElementById('statusImageUrl').value.trim(),
      mimetype: document.getElementById('statusImageMime').value.trim() || 'image/jpeg',
    };
  } else if (type === 'video') {
    payload.text = document.getElementById('statusText').value;
    payload.video = {
      url: document.getElementById('statusVideoUrl').value.trim(),
      mimetype: document.getElementById('statusVideoMime').value.trim() || 'video/mp4',
      duration: Number(document.getElementById('statusVideoDuration').value) || undefined,
    };
  }
  return payload;
}

function updateStatusPayloadPreview() {
  document.getElementById('statusPayloadPreview').textContent = JSON.stringify(buildStatusPayload(), null, 2);
}

async function sendStatus() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  const payload = buildStatusPayload();
  try {
    const data = await callApi({
      method: 'POST',
      path: '/status',
      headers: authHeaders(s),
      body: payload,
    });
    showToast('Status terkirim! statusId: ' + (data.statusId || '-'), 'success');
  } catch (e) {
    showToast('Gagal kirim status: ' + e.message, 'error');
  }
}

/* =====================================================================
   TYPING API
   ===================================================================== */

function buildTypingPayload() {
  const target = document.querySelector('input[name="typingTarget"]:checked').value;
  const payload = { type: document.getElementById('typingType').value };
  if (target === 'phone') {
    payload.phone = document.getElementById('typingPhone').value.trim();
  } else {
    payload.group = document.getElementById('typingGroup').value.trim();
  }
  return payload;
}

function updateTypingPayloadPreview() {
  document.getElementById('typingPayloadPreview').textContent = JSON.stringify(buildTypingPayload(), null, 2);
}

async function sendTyping() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  const payload = buildTypingPayload();
  try {
    await callApi({
      method: 'POST',
      path: '/typing',
      headers: authHeaders(s),
      body: payload,
    });
    showToast('Typing presence terkirim', 'success');
  } catch (e) {
    showToast('Gagal kirim typing: ' + e.message, 'error');
  }
}

/* =====================================================================
   GROUP API
   ===================================================================== */

async function fetchGroups() {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }

  try {
    const data = await callApi({
      method: 'GET',
      path: '/group',
      headers: authHeaders(s),
    });
    const groups = Array.isArray(data.docs) ? data.docs : [];
    upsertActiveSessionFields({ groups });
    renderGroupList();
    showToast(`Berhasil ambil ${groups.length} grup`, 'success');
  } catch (e) {
    showToast('Gagal ambil grup: ' + e.message, 'error');
  }
}

/* =====================================================================
   RENDER: Sidebar session list
   ===================================================================== */

function renderSessionList() {
  const list = document.getElementById('sessionList');
  const empty = document.getElementById('sessionEmpty');
  document.getElementById('sessionCount').textContent = state.sessions.length;

  list.querySelectorAll('.session-item').forEach(el => el.remove());

  if (state.sessions.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.sessions.slice().reverse().forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.localId === state.activeLocalId ? ' active' : '');
    item.dataset.localId = s.localId;

    const dotClass = s.isConnected ? 'dot-on' : (s.qrcode ? 'dot-pending' : 'dot-off');
    const displayName = s.name || 'Belum terhubung';

    item.innerHTML = `
      <div class="session-item-top">
        <span class="dot ${dotClass}"></span>
        <span class="session-item-name">${escapeHtml(displayName)}</span>
      </div>
      <div class="session-item-id">${escapeHtml(s.id.slice(0, 24))}</div>
      <button class="session-item-del" title="Hapus dari daftar lokal" data-local-id="${s.localId}">✕</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-item-del')) return;
      setActiveSession(s.localId);
    });

    list.appendChild(item);
  });

  list.querySelectorAll('.session-item-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const localId = btn.dataset.localId;
      showConfirmModal({
        title: 'Hapus dari daftar lokal?',
        body: 'Ini cuma hapus dari daftar di browser kamu, ngga manggil API hapus ke server. Kalau mau hapus di server juga, pakai tombol "Hapus Session" di tab Session.',
        onConfirm: () => removeSessionLocally(localId),
      });
    });
  });
}

function setActiveSession(localId) {
  state.activeLocalId = localId;
  saveState();
  renderSessionList();
  renderActiveSessionTopbar();
  renderSessionPanel();
  renderGroupList();
}

function renderActiveSessionTopbar() {
  const s = getActiveSession();
  const dot = document.getElementById('activeDot');
  const nameEl = document.getElementById('activeSessionName');
  const idEl = document.getElementById('activeSessionId');

  if (!s) {
    dot.className = 'dot dot-off';
    nameEl.textContent = 'Tidak ada session aktif';
    idEl.textContent = '—';
    return;
  }

  dot.className = 'dot ' + (s.isConnected ? 'dot-on' : (s.qrcode ? 'dot-pending' : 'dot-off'));
  nameEl.textContent = s.name || (s.isConnected ? 'Terhubung' : 'Belum terhubung');
  idEl.textContent = `id: ${s.id}`;
}

/* =====================================================================
   RENDER: Session panel (QR + info)
   ===================================================================== */

function renderSessionPanel() {
  const s = getActiveSession();
  const qrBox = document.getElementById('qrBox');
  const infoGrid = document.getElementById('sessionInfoGrid');

  if (!s) {
    qrBox.innerHTML = `<span class="qr-placeholder">Belum ada session aktif.</span>`;
    infoGrid.innerHTML = '';
    return;
  }

  if (s.isConnected) {
    qrBox.innerHTML = `
      <div class="qr-connected">
        ${s.picture ? `<img src="${escapeAttr(s.picture)}" alt="profile">` : ''}
        <span>✓ Terhubung${s.name ? ' sebagai ' + escapeHtml(s.name) : ''}</span>
      </div>
    `;
  } else if (s.qrcode) {
    const src = s.qrcode.startsWith('data:') ? s.qrcode : `data:image/png;base64,${s.qrcode}`;
    qrBox.innerHTML = `<img src="${escapeAttr(src)}" alt="QR Code">`;
  } else {
    qrBox.innerHTML = `<span class="qr-placeholder">Belum ada QR. Klik "Ambil Session".</span>`;
  }

  infoGrid.innerHTML = `
    <span class="k">id</span><span class="v">${escapeHtml(s.id)}</span>
    <span class="k">sessionId</span><span class="v">${escapeHtml(s.sessionId)}</span>
    <span class="k">isConnected</span><span class="v">${s.isConnected}</span>
    <span class="k">dibuat</span><span class="v">${new Date(s.createdAt).toLocaleString('id-ID')}</span>
  `;
}

/* =====================================================================
   RENDER: Group list
   ===================================================================== */

function renderGroupList() {
  const s = getActiveSession();
  const container = document.getElementById('groupList');

  const groups = s && Array.isArray(s.groups) ? s.groups : [];

  if (groups.length === 0) {
    container.innerHTML = `<div class="empty-state">Belum ada data. Klik "Ambil Group".</div>`;
    return;
  }

  container.innerHTML = groups.map(g => `
    <div class="group-item" data-group-id="${escapeAttr(g.id)}">
      <div>
        <div class="group-item-name">${escapeHtml(g.name || '(tanpa nama)')}</div>
        ${g.description ? `<div class="group-item-desc">${escapeHtml(g.description)}</div>` : ''}
        <div class="group-item-id">${escapeHtml(g.id)}</div>
      </div>
      <button class="group-item-action" data-group-id="${escapeAttr(g.id)}">Kirim ke sini</button>
    </div>
  `).join('');

  container.querySelectorAll('.group-item-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = btn.dataset.groupId;
      // pindah ke tab message, isi group field
      switchTab('message');
      document.querySelector('input[name="msgTarget"][value="group"]').checked = true;
      document.getElementById('msgGroup').value = groupId;
      toggleMessageTargetFields();
      updateMessagePayloadPreview();
      showToast('Group ID disalin ke form Kirim Pesan', 'success');
    });
  });

  container.querySelectorAll('.group-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.groupId;
      navigator.clipboard?.writeText(id).then(() => {
        showToast('Group ID disalin ke clipboard', 'success');
      }).catch(() => {});
    });
  });
}

/* =====================================================================
   Tabs
   ===================================================================== */

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tabName));
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

/* =====================================================================
   Message / Status / Typing field toggling
   ===================================================================== */

function toggleMessageTargetFields() {
  const target = document.querySelector('input[name="msgTarget"]:checked').value;
  document.getElementById('msgPhone').closest('.field').classList.toggle('hidden', target !== 'phone');
  document.getElementById('msgGroupField').classList.toggle('hidden', target !== 'group');
}

function toggleMessageTypeFields() {
  const type = document.getElementById('msgType').value;
  document.querySelectorAll('.msg-type-fields').forEach(el => {
    const types = el.dataset.type.split(',');
    el.classList.toggle('hidden', !types.includes(type));
  });
}

function toggleTypingTargetFields() {
  const target = document.querySelector('input[name="typingTarget"]:checked').value;
  document.getElementById('typingPhone').closest('.field').classList.toggle('hidden', target !== 'phone');
  document.getElementById('typingGroupField').classList.toggle('hidden', target !== 'group');
}

function toggleStatusTypeFields() {
  const type = document.getElementById('statusType').value;
  document.querySelectorAll('.status-type-fields').forEach(el => {
    const types = el.dataset.type.split(',');
    el.classList.toggle('hidden', !types.includes(type));
  });
}

document.querySelectorAll('input[name="msgTarget"]').forEach(r => r.addEventListener('change', () => {
  toggleMessageTargetFields(); updateMessagePayloadPreview();
}));
document.getElementById('msgType').addEventListener('change', () => {
  toggleMessageTypeFields(); updateMessagePayloadPreview();
});
document.querySelectorAll('input[name="typingTarget"]').forEach(r => r.addEventListener('change', () => {
  toggleTypingTargetFields(); updateTypingPayloadPreview();
}));
document.getElementById('typingType').addEventListener('change', updateTypingPayloadPreview);
document.getElementById('statusType').addEventListener('change', () => {
  toggleStatusTypeFields(); updateStatusPayloadPreview();
});

// live preview on any input change within message/status/typing panels
['panel-message', 'panel-status', 'panel-typing'].forEach(panelId => {
  document.getElementById(panelId).addEventListener('input', () => {
    if (panelId === 'panel-message') updateMessagePayloadPreview();
    if (panelId === 'panel-status') updateStatusPayloadPreview();
    if (panelId === 'panel-typing') updateTypingPayloadPreview();
  });
});

/* =====================================================================
   Auto refresh QR
   ===================================================================== */

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    const s = getActiveSession();
    if (!s || s.isConnected) { stopAutoRefresh(); return; }
    fetchSessionInfo();
  }, 3000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

document.getElementById('toggleAutoRefresh').addEventListener('change', (e) => {
  if (e.target.checked) {
    if (!getActiveSession()) {
      showToast('Pilih atau buat session dulu', 'warn');
      e.target.checked = false;
      return;
    }
    startAutoRefresh();
    showToast('Auto-refresh diaktifkan', 'success');
  } else {
    stopAutoRefresh();
  }
});

/* =====================================================================
   Request log drawer
   ===================================================================== */

let logEntries = [];
let logIdCounter = 0;

function addLogEntry({ method, url, requestHeaders, requestBody, status }) {
  const id = ++logIdCounter;
  logEntries.unshift({
    id, method, url, requestHeaders, requestBody, status,
    httpStatus: null, responseBody: null, time: new Date(),
  });
  if (logEntries.length > 100) logEntries.pop();
  renderLogDrawer();
  return id;
}

function updateLogEntry(id, fields) {
  const entry = logEntries.find(l => l.id === id);
  if (!entry) return;
  Object.assign(entry, fields);
  renderLogDrawer();
}

function renderLogDrawer() {
  document.getElementById('logCount').textContent = logEntries.length;
  const body = document.getElementById('logDrawerBody');

  if (logEntries.length === 0) {
    body.innerHTML = `<div class="log-empty">Belum ada request. Aksi yang kamu lakuin bakal muncul di sini.</div>`;
    return;
  }

  body.innerHTML = logEntries.map(entry => {
    const baseUrl = getBaseUrl();
    let path;
    if (baseUrl.includes('/api/proxy')) {
      // mode proxy: ekstrak nilai ?path=... dari url buat ditampilin
      try {
        const u = new URL(entry.url);
        path = u.searchParams.get('path') || entry.url;
      } catch {
        path = entry.url;
      }
    } else {
      path = entry.url.replace(baseUrl, '');
    }
    const statusClass = entry.status === 'pending' ? 'pending' : (entry.status === 'ok' ? 'ok' : 'err');
    const statusLabel = entry.status === 'pending' ? '...' : (entry.httpStatus ?? 'ERR');

    return `
      <div class="log-entry" data-log-id="${entry.id}">
        <div class="log-entry-head" data-toggle-id="${entry.id}">
          <span class="log-method ${entry.method}">${entry.method}</span>
          <span class="log-endpoint">${escapeHtml(path)}</span>
          <span class="log-time">${entry.time.toLocaleTimeString('id-ID')}</span>
          <span class="log-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="log-entry-detail">
          ${entry.requestHeaders && Object.keys(entry.requestHeaders).length ? `
            <div>
              <div class="log-detail-label">REQUEST HEADERS</div>
              <div class="log-detail-block">${escapeHtml(JSON.stringify(entry.requestHeaders, null, 2))}</div>
            </div>` : ''}
          ${entry.requestBody ? `
            <div>
              <div class="log-detail-label">REQUEST BODY</div>
              <div class="log-detail-block">${escapeHtml(JSON.stringify(entry.requestBody, null, 2))}</div>
            </div>` : ''}
          <div>
            <div class="log-detail-label">RESPONSE</div>
            <div class="log-detail-block">${escapeHtml(typeof entry.responseBody === 'string' ? entry.responseBody : JSON.stringify(entry.responseBody, null, 2))}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  body.querySelectorAll('.log-entry-head').forEach(head => {
    head.addEventListener('click', () => {
      head.closest('.log-entry').classList.toggle('expanded');
    });
  });
}

document.getElementById('logDrawerToggle').addEventListener('click', (e) => {
  if (e.target.id === 'btnClearLog') return;
  const drawer = document.getElementById('logDrawer');
  drawer.classList.toggle('collapsed');
  document.getElementById('logToggleIcon').textContent = drawer.classList.contains('collapsed') ? '▴' : '▾';
});

document.getElementById('btnClearLog').addEventListener('click', (e) => {
  e.stopPropagation();
  logEntries = [];
  renderLogDrawer();
});

/* =====================================================================
   Toasts
   ===================================================================== */

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4200);
}

/* =====================================================================
   Confirm modal
   ===================================================================== */

let pendingConfirmAction = null;

function showConfirmModal({ title, body, onConfirm }) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').textContent = body;
  pendingConfirmAction = onConfirm;
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function hideConfirmModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  pendingConfirmAction = null;
}

document.getElementById('modalCancel').addEventListener('click', hideConfirmModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'modalOverlay') hideConfirmModal();
});
document.getElementById('modalConfirm').addEventListener('click', () => {
  const action = pendingConfirmAction;
  hideConfirmModal();
  if (action) action();
});

/* =====================================================================
   Export / Import
   ===================================================================== */

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    baseUrl: getBaseUrl(),
    sessions: state.sessions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zawa-sessions-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Data session berhasil di-export', 'success');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!Array.isArray(parsed.sessions)) throw new Error('Format file ngga valid (tidak ada array sessions)');

      let imported = 0;
      parsed.sessions.forEach(s => {
        if (!s.id || !s.sessionId) return;
        // avoid duplicate by id+sessionId
        const exists = state.sessions.some(existing => existing.id === s.id && existing.sessionId === s.sessionId);
        if (exists) return;
        state.sessions.push({
          localId: genLocalId(),
          id: s.id,
          sessionId: s.sessionId,
          name: s.name || null,
          isConnected: !!s.isConnected,
          qrcode: s.qrcode || null,
          picture: s.picture || null,
          createdAt: s.createdAt || Date.now(),
          groups: Array.isArray(s.groups) ? s.groups : [],
        });
        imported++;
      });

      if (parsed.baseUrl) {
        document.getElementById('baseUrlInput').value = parsed.baseUrl;
        localStorage.setItem(BASEURL_KEY, parsed.baseUrl);
      }

      if (!state.activeLocalId && state.sessions.length) {
        state.activeLocalId = state.sessions[0].localId;
      }

      saveState();
      renderSessionList();
      renderActiveSessionTopbar();
      renderSessionPanel();
      renderGroupList();
      showToast(`Import berhasil: ${imported} session ditambahkan`, 'success');
    } catch (err) {
      showToast('Gagal import: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

/* =====================================================================
   Utility
   ===================================================================== */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

/* =====================================================================
   Event bindings
   ===================================================================== */

document.getElementById('btnNewSession').addEventListener('click', createNewSession);
document.getElementById('btnFetchSession').addEventListener('click', fetchSessionInfo);
document.getElementById('btnResetSession').addEventListener('click', () => {
  const s = getActiveSession();
  if (!s) { showToast('Belum ada session aktif', 'warn'); return; }
  showConfirmModal({
    title: 'Reset Session?',
    body: 'QR code dan status koneksi bakal direset. Kamu perlu scan ulang.',
    onConfirm: resetSession,
  });
});
document.getElementById('btnDeleteSession').addEventListener('click', deleteSessionFlow);
document.getElementById('btnSendMessage').addEventListener('click', sendMessage);
document.getElementById('btnSendStatus').addEventListener('click', sendStatus);
document.getElementById('btnSendTyping').addEventListener('click', sendTyping);
document.getElementById('btnFetchGroups').addEventListener('click', fetchGroups);

document.getElementById('btnExport').addEventListener('click', exportData);
document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importData(file);
  e.target.value = '';
});

document.getElementById('baseUrlInput').addEventListener('change', (e) => {
  localStorage.setItem(BASEURL_KEY, e.target.value.trim());
});

/* =====================================================================
   Init
   ===================================================================== */

function init() {
  loadState();
  renderSessionList();
  renderActiveSessionTopbar();
  renderSessionPanel();
  renderGroupList();
  renderLogDrawer();

  toggleMessageTargetFields();
  toggleMessageTypeFields();
  toggleTypingTargetFields();
  toggleStatusTypeFields();
  updateMessagePayloadPreview();
  updateStatusPayloadPreview();
  updateTypingPayloadPreview();
}

init();
