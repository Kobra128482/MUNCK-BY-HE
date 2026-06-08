'use strict';
/* ================================================================
   VerifyOne – Munck Civil Engineering | app.js
   Firebase Realtime Database for live cross-device sync
================================================================ */

// ─── Firebase Config ─────────────────────────────────────────────
// NOTE: Replace with your own Firebase project config from
// https://console.firebase.google.com  (free Spark plan is enough)
const firebaseConfig = {
  apiKey:            "AIzaSyD2Jt6PoKLFkL4yK0h0YeC2jhUU9v7ebjU",
  authDomain:        "munck-by-he.firebaseapp.com",
  databaseURL:       "https://munck-by-he-default-rtdb.firebaseio.com",
  projectId:         "munck-by-he",
  storageBucket:     "munck-by-he.firebasestorage.app",
  messagingSenderId: "565263953032",
  appId:             "1:565263953032:web:c61fe1159d03b037f4833d",
  measurementId:     "G-ZVYGYM22W8"
};

let db = null;
let firebaseReady = false;

function initFirebase() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    firebaseReady = true;
    console.log('[VerifyOne] Firebase connected.');
    startRealtimeListeners();
  } catch (e) {
    console.warn('[VerifyOne] Firebase not configured. Running in local-only mode.', e.message);
    firebaseReady = false;
    // Fall back to localStorage
  }
}

// ─── Storage Keys (localStorage fallback) ────────────────────────
const K = {
  employees:    'vo_employees',
  logs:         'vo_logs',
  users:        'vo_users',
  designations: 'vo_designations',
  creds:        'vo_creds',
  session:      'vo_session',
};

// ─── Default Credentials ─────────────────────────────────────────
const DEF_CREDS = {
  admin:  { username: 'admin',  password: 'gems2024', role: 'admin' },
  master: { username: 'master', password: 'munck2026', role: 'master' },
};

const DEFAULT_DESIGNATIONS = [
  'Guard', 'Senior Guard', 'Supervisor', 'QRF', 'Control Room Operator',
  'Site Manager', 'Site Engineer', 'Labour', 'Mason', 'Electrician', 'Welder',
  'Driver', 'Visitor'
];

// ─── In-Memory State ─────────────────────────────────────────────
let STATE = {
  employees:    [],
  logs:         [],
  users:        [],
  designations: [],
};

let currentSession  = null;   // { username, role }
let currentTab      = 'dashboard';
let currentCatTab   = 'all';
let qrScanner       = null;
let scanRunning     = false;
let flashActive     = false;
let activeStream    = null;
let masterClickCount = 0;
let masterClickTimer = null;
let sidebarCollapsed = false;
let quoteInterval   = null;
let currentQuoteIdx = 0;

// ─── Helpers ──────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const isToday = iso => { const d=new Date(iso),n=new Date(); return d.toDateString()===n.toDateString(); };
const fmtDT = iso => new Date(iso).toLocaleString('en-PK',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
const fmtT  = iso => new Date(iso).toLocaleTimeString('en-PK',{hour:'2-digit',minute:'2-digit',hour12:true});
const genId = pfx => (pfx||'ID')+'-'+Date.now();
const $ = id => document.getElementById(id);

const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect width='80' height='80' fill='%23e2e8f0'/%3E%3Ccircle cx='40' cy='30' r='16' fill='%23cbd5e1'/%3E%3Cellipse cx='40' cy='70' rx='24' ry='18' fill='%23cbd5e1'/%3E%3C/svg%3E";

// ─── Toast ────────────────────────────────────────────────────────
function toast(msg, dur=2800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

// ─── Screens ──────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const el = $(id);
  el.style.display = 'flex';
  requestAnimationFrame(() => el.classList.add('active'));
}

// ─── Session (persisted across refresh) ──────────────────────────
function saveSession(sess) {
  currentSession = sess;
  localStorage.setItem(K.session, JSON.stringify(sess));
}
function clearSession() {
  currentSession = null;
  localStorage.removeItem(K.session);
}
function restoreSession() {
  const raw = localStorage.getItem(K.session);
  if (!raw) return false;
  try {
    currentSession = JSON.parse(raw);
    return true;
  } catch { return false; }
}

// ─── DB: Firebase + localStorage fallback ─────────────────────────
function getLocal(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) || def; } catch { return def; }
}
function setLocal(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function loadAll() {
  STATE.employees    = getLocal(K.employees, []);
  STATE.logs         = getLocal(K.logs, []);
  STATE.users        = getLocal(K.users, []);
  STATE.designations = getLocal(K.designations, []);
  if (!STATE.designations.length) {
    STATE.designations = [...DEFAULT_DESIGNATIONS];
    setLocal(K.designations, STATE.designations);
  }
}

function saveEmployees() { setLocal(K.employees, STATE.employees); syncToFirebase('employees', STATE.employees); }
function saveLogs()      { setLocal(K.logs,      STATE.logs);      syncToFirebase('logs',      STATE.logs);      }
function saveUsers()     { setLocal(K.users,      STATE.users);     syncToFirebase('users',     STATE.users);     }
function saveDesigs()    { setLocal(K.designations, STATE.designations); syncToFirebase('designations', STATE.designations); }

function syncToFirebase(path, data) {
  if (!firebaseReady || !db) return;
  db.ref('verifyone/' + path).set(data).catch(e => console.warn('Firebase write error:', e));
}

function startRealtimeListeners() {
  if (!firebaseReady || !db) return;
  const paths = ['employees','logs','users','designations'];
  paths.forEach(p => {
    db.ref('verifyone/' + p).on('value', snap => {
      const val = snap.val();
      if (val && Array.isArray(val)) {
        STATE[p] = val;
        setLocal(K[p] || 'vo_'+p, val);
        onRemoteUpdate(p);
      }
    });
  });
}

function onRemoteUpdate(path) {
  if (currentTab === 'dashboard')   refreshDashboard();
  if (currentTab === 'staff')       renderStaff();
  if (currentTab === 'users')       renderUsers();
  if (currentTab.startsWith('rep')) renderReport(currentTab.replace('rep-',''));
  if (currentTab === 'idcards')     renderIDCards();
  if (currentTab === 'settings' && path === 'designations') renderDesigList();
}

// ─── Credentials ──────────────────────────────────────────────────
function getCreds() {
  return getLocal(K.creds, {
    admin:  { username: DEF_CREDS.admin.username,  password: DEF_CREDS.admin.password },
    master: { username: DEF_CREDS.master.username, password: DEF_CREDS.master.password },
  });
}

function validateLogin(uname, pass) {
  const creds = getCreds();
  if (uname === creds.master.username && pass === creds.master.password) return 'master';
  if (uname === creds.admin.username  && pass === creds.admin.password)  return 'admin';
  // Check dynamic users
  const u = STATE.users.find(x => x.username === uname && x.password === pass);
  if (u) return u.role || 'scanner';
  return null;
}

// ─── Login / Logout ───────────────────────────────────────────────
function doLogin() {
  const u = $('login-username').value.trim();
  const p = $('login-password').value;
  const role = validateLogin(u, p);
  if (role) {
    $('login-error').classList.add('hidden');
    saveSession({ username: u, role });
    enterApp(role);
  } else {
    $('login-error').classList.remove('hidden');
    $('login-password').value = '';
  }
}

// ─── Staff Modal Image Upload ─────────────────────────────────────
let modalUploadedBase64 = '';

function handleModalImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    modalUploadedBase64 = e.target.result;
    const photoInput = $('m-photo');
    if (photoInput) photoInput.value = '';
    const preview = $('m-upload-preview-wrap');
    if (preview) preview.classList.remove('hidden');
    toast('✓ Image uploaded successfully');
  };
  reader.readAsDataURL(file);
}

function clearUploadedImage() {
  modalUploadedBase64 = '';
  const fileInput = $('m-file-upload');
  if (fileInput) fileInput.value = '';
  const preview = $('m-upload-preview-wrap');
  if (preview) preview.classList.add('hidden');
  toast('Uploaded image removed');
}

function enterApp(role) {
  if (role === 'master' || role === 'admin') {
    showScreen('screen-admin');
    refreshDashboard();
    renderStaff();
    renderUsers();
    renderReport('labour');
    renderReport('guard');
    renderReport('visitor');
    renderIDCards();
    renderDesigList();
    renderPermList();
    startAdminClock();
  } else {
    // Scanner-only roles
    showScreen('screen-scanner');
    startScanner();
    tickScannerTime();
  }
}

function logout() {
  stopScanner();
  clearSession();
  $('login-username').value = '';
  $('login-password').value = '';
  $('login-error').classList.add('hidden');
  showScreen('screen-login');
}

function togglePassword() {
  const inp = $('login-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ─── Master Overlay ────────────────────────────────────────────────
let _wDbl = 0;
function initWatermarkDblClick() {
  const btn = $('watermark-btn');
  btn.addEventListener('click', () => {
    const now = Date.now();
    if (now - _wDbl < 500) openMasterOverlay();
    _wDbl = now;
  });
}
function openMasterOverlay() {
  $('master-user').value = '';
  $('master-pass').value = '';
  $('master-err').classList.add('hidden');
  $('master-overlay').classList.remove('hidden');
}
function closeMasterOverlay() { $('master-overlay').classList.add('hidden'); }
function doMasterLogin() {
  const u = $('master-user').value.trim();
  const p = $('master-pass').value;
  const creds = getCreds();
  if (u === creds.master.username && p === creds.master.password) {
    closeMasterOverlay();
    saveSession({ username: u, role: 'master' });
    enterApp('master');
  } else {
    $('master-err').classList.remove('hidden');
  }
}

// ─── Login Quote Rotator ──────────────────────────────────────────
function startQuoteRotator() {
  const quotes = document.querySelectorAll('.login-quote');
  const total = quotes.length;
  quoteInterval = setInterval(() => {
    quotes[currentQuoteIdx].classList.remove('active');
    currentQuoteIdx = (currentQuoteIdx + 1) % total;
    quotes[currentQuoteIdx].classList.add('active');
  }, 4000);
}

// ─── Admin Clock ──────────────────────────────────────────────────
function startAdminClock() {
  const update = () => {
    const el = $('dash-date-label');
    if (el) el.textContent = new Date().toLocaleDateString('en-PK',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  };
  update();
  setInterval(update, 60000);
}

// ─── Sidebar Collapse ─────────────────────────────────────────────
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sb = $('sidebar');
  sb.classList.toggle('collapsed', sidebarCollapsed);
}

// ─── Sub-menu Toggle ──────────────────────────────────────────────
function toggleSubMenu(subId, btnId) {
  const sub = $(subId);
  const btn = $(btnId);
  const isOpen = !sub.classList.contains('hidden');
  sub.classList.toggle('hidden', isOpen);
  btn.classList.toggle('open', !isOpen);
  // Auto-activate first sub
  if (!isOpen) switchTab('rep-labour');
}

// ─── Tab Switching ────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.atab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.snav,.snav-sub-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.mbnav').forEach(n => n.classList.remove('active'));

  // Show the correct atab
  const tabEl = $('atab-' + tab);
  if (tabEl) tabEl.classList.add('active');

  // Highlight sidebar nav
  const navEl = $('snav-' + tab) || $('snav-rep-' + tab.replace('rep-',''));
  if (navEl) navEl.classList.add('active');

  // Highlight mobile nav
  const mobMap = { 'dashboard':'dashboard','staff':'staff','users':'users','rep-labour':'reports','rep-guard':'reports','rep-visitor':'reports','settings':'settings','idcards':'settings' };
  const mobTarget = 'mbnav-' + (mobMap[tab] || tab);
  if ($(mobTarget)) $(mobTarget).classList.add('active');

  if (tab === 'dashboard')   refreshDashboard();
  if (tab === 'staff')       renderStaff();
  if (tab === 'users')       renderUsers();
  if (tab === 'rep-labour')  renderReport('labour');
  if (tab === 'rep-guard')   renderReport('guard');
  if (tab === 'rep-visitor') renderReport('visitor');
  if (tab === 'idcards')     renderIDCards();
  if (tab === 'settings') {  renderDesigList(); renderPermList(); }
}

// ─── Dashboard ────────────────────────────────────────────────────
function refreshDashboard() {
  const emps = STATE.employees;
  const logs = STATE.logs;
  const todayLogs = logs.filter(l => isToday(l.timestamp));

  const categories = ['labour','guard','visitor'];
  const ids = { labour:'dl', guard:'dg', visitor:'dv' };
  categories.forEach(cat => {
    const pre = ids[cat];
    const group = emps.filter(e => e.category === cat);
    const onDuty = group.filter(e => e.status === 'On-Duty');
    const offDuty = group.filter(e => e.status === 'Off-Duty');
    const scanned = todayLogs.filter(l => l.category === cat);
    if ($(pre+'-total'))   $(pre+'-total').textContent   = group.length;
    if ($(pre+'-on'))      $(pre+'-on').textContent      = onDuty.length;
    if ($(pre+'-off'))     $(pre+'-off').textContent     = offDuty.length;
    if ($(pre+'-scanned')) $(pre+'-scanned').textContent = scanned.length;
  });
  // Visitors: Arrived = On-Duty; Departed = Off-Duty
  const vis = emps.filter(e => e.category === 'visitor');
  if ($('dv-arrived'))  $('dv-arrived').textContent  = vis.filter(e => e.status === 'On-Duty').length;
  if ($('dv-departed')) $('dv-departed').textContent = vis.filter(e => e.status === 'Off-Duty').length;

  // Force grid
  const onDutyAll = emps.filter(e => e.status === 'On-Duty');
  const countBadge = $('force-count-badge');
  if (countBadge) countBadge.textContent = onDutyAll.length + ' Personnel';
  const gridEl = $('force-grid');
  if (gridEl) {
    if (onDutyAll.length === 0) {
      gridEl.innerHTML = '<p class="empty-msg" style="grid-column:1/-1">No personnel currently On-Duty.</p>';
    } else {
      gridEl.innerHTML = onDutyAll.map(g => `
        <div class="force-card">
          <div class="fc-on-badge"></div>
          <img class="fc-photo" src="${esc(g.photo||PLACEHOLDER)}" alt="${esc(g.name)}" onerror="this.src='${PLACEHOLDER}'" />
          <div class="fc-name">${esc(g.name)}</div>
          <div class="fc-id">${esc(g.id)}</div>
          <span class="fc-role">${esc(g.role||'—')}</span>
          <div class="fc-post">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${esc(g.sector||'—')}
          </div>
        </div>
      `).join('');
    }
  }

  // Recent scans
  const recentEl = $('recent-list');
  if (recentEl) {
    if (!logs.length) { recentEl.innerHTML = '<p class="empty-msg">No scans recorded yet.</p>'; return; }
    recentEl.innerHTML = logs.slice(0, 10).map(l => `
      <div class="ract-item">
        <span class="ract-dot"></span>
        <div class="ract-main">
          <strong>${esc(l.guardName||l.guardId)}</strong>
          <span>${esc(l.guardId)} &nbsp;·&nbsp; ${esc(l.sector||'—')}</span>
        </div>
        <span class="ract-cat ${esc(l.category||'guard')}">${capitalise(l.category||'guard')}</span>
        <span class="ract-time">${fmtT(l.timestamp)}</span>
      </div>
    `).join('');
  }
}

// ─── Staff Rendering ──────────────────────────────────────────────
let catFilter = 'all';

function switchCatTab(cat) {
  catFilter = cat;
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  $('ctab-'+cat)?.classList.add('active');
  renderStaff();
}

function renderStaff() {
  let emps = [...STATE.employees];
  const q  = ($('g-search')?.value||'').toLowerCase();
  const sf = $('g-status')?.value||'';
  if (catFilter !== 'all') emps = emps.filter(e => e.category === catFilter);
  if (q)  emps = emps.filter(e => e.name.toLowerCase().includes(q)||e.id.toLowerCase().includes(q)||(e.sector||'').toLowerCase().includes(q));
  if (sf) emps = emps.filter(e => e.status === sf);

  const tbody = $('g-tbody');
  const empty = $('g-empty');
  if (!emps.length) { if(tbody) tbody.innerHTML=''; if(empty) empty.style.display='block'; return; }
  if (empty) empty.style.display='none';
  tbody.innerHTML = emps.map(g => {
    const on = g.status === 'On-Duty';
    return `<tr>
      <td><div class="guard-cell">
        <img class="g-avatar" src="${esc(g.photo||PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="" />
        <div><span class="g-name">${esc(g.name)}</span><span class="g-role-sm">${esc(g.role||'')}</span></div>
      </div></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.74rem;color:#64748b">${esc(g.id)}</td>
      <td><span class="chip chip-${esc(g.category||'guard')}">${capitalise(g.category||'guard')}</span></td>
      <td>${esc(g.sector||'—')}</td>
      <td>${esc(g.shift||'—')}${g.shiftStart?` <small style="color:#94a3b8">${g.shiftStart}–${g.shiftEnd||'?'}</small>`:''}</td>
      <td><span class="chip ${on?'chip-on':'chip-off'}">${esc(g.status)}</span></td>
      <td><div class="tbl-acts">
        <button class="tbl-btn edit" onclick="openModal('${esc(g.id)}')" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="tbl-btn qr" onclick="showQR('${esc(g.id)}')" title="View QR"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
        <button class="tbl-btn print" onclick="printCard('${esc(g.id)}')" title="Print Card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>
        <button class="tbl-btn del" onclick="delStaff('${esc(g.id)}')" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>
      </div></td>
    </tr>`;
  }).join('');
}

// ─── Staff Modal ──────────────────────────────────────────────────
function openModal(empId) {
  $('m-err').classList.add('hidden');
  populateDesigSelect('m-role');
  
  // Reset image upload states
  modalUploadedBase64 = '';
  const fileInput = $('m-file-upload');
  if (fileInput) fileInput.value = '';
  const preview = $('m-upload-preview-wrap');
  if (preview) preview.classList.add('hidden');

  if (empId) {
    const g = STATE.employees.find(x => x.id === empId);
    if (!g) return;
    $('modal-title').textContent = 'Edit Staff';
    $('m-orig-id').value  = g.id;
    $('m-id').value       = g.id;
    $('m-name').value     = g.name;
    $('m-cnic').value     = g.cnic||'';
    $('m-phone').value    = g.phone||'';
    $('m-dob').value      = g.dob||'';
    $('m-category').value = g.category||'guard';
    $('m-role').value     = g.role||'Guard';
    $('m-shift').value    = g.shift||'Day';
    $('m-shift-start').value = g.shiftStart||'';
    $('m-shift-end').value   = g.shiftEnd||'';
    $('m-sector').value   = g.sector||'';
    $('m-weapon').value   = g.weapon||'Unarmed';
    $('m-status').value   = g.status||'On-Duty';
    
    // Set photo source
    if (g.photo) {
      if (g.photo.startsWith('data:image/')) {
        modalUploadedBase64 = g.photo;
        if (preview) preview.classList.remove('hidden');
        $('m-photo').value = '';
      } else {
        $('m-photo').value = g.photo;
      }
    } else {
      $('m-photo').value = '';
    }

    $('m-issue').value    = g.issue||'';
    $('m-expiry').value   = g.expiry||'';
  } else {
    $('modal-title').textContent = 'Add New Staff';
    $('m-orig-id').value = '';
    ['m-id','m-name','m-cnic','m-phone','m-sector','m-photo'].forEach(id => $(id).value='');
    $('m-dob').value=''; $('m-issue').value=''; $('m-expiry').value='';
    $('m-role').value = 'Guard';
    $('m-shift').value = 'Day';
    $('m-shift-start').value = '';
    $('m-shift-end').value = '';
    $('m-category').value = 'guard';
    $('m-weapon').value = 'Unarmed';
    $('m-status').value = 'On-Duty';
  }
  toggleShiftTimes();
  $('modal-overlay').classList.remove('hidden');
}

function closeModal(e) {
  if (e && e.target !== $('modal-overlay')) return;
  $('modal-overlay').classList.add('hidden');
}

function toggleShiftTimes() {
  const shift = $('m-shift').value;
  $('shift-times-row').style.display = (shift === 'Day' || shift === 'Night') ? 'grid' : 'none';
}

function saveStaff() {
  const id   = $('m-id').value.trim();
  const name = $('m-name').value.trim();
  const errEl = $('m-err');
  if (!id||!name) { errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');

  const origId = $('m-orig-id').value;
  const isEdit = Boolean(origId);
  const shift  = $('m-shift').value;
  const hasTime = (shift === 'Day' || shift === 'Night');

  const empData = {
    id, name,
    cnic:       $('m-cnic').value.trim(),
    phone:      $('m-phone').value.trim(),
    dob:        $('m-dob').value,
    category:   $('m-category').value,
    role:       $('m-role').value,
    shift,
    shiftStart: hasTime ? $('m-shift-start').value : '',
    shiftEnd:   hasTime ? $('m-shift-end').value : '',
    sector:     $('m-sector').value.trim(),
    weapon:     $('m-weapon').value,
    status:     $('m-status').value,
    photo:      modalUploadedBase64 || $('m-photo').value.trim(),
    issue:      $('m-issue').value,
    expiry:     $('m-expiry').value,
    addedAt:    origId ? (STATE.employees.find(x=>x.id===origId)?.addedAt || new Date().toISOString()) : new Date().toISOString(),
  };

  if (isEdit) {
    const i = STATE.employees.findIndex(g => g.id === origId);
    if (i !== -1) STATE.employees[i] = empData;
    toast('✓ Staff record updated.');
  } else {
    if (STATE.employees.find(g => g.id.toLowerCase() === id.toLowerCase())) {
      errEl.textContent = `Employee ID "${id}" already exists.`;
      errEl.classList.remove('hidden'); return;
    }
    STATE.employees.push(empData);
    toast('✓ Staff member added.');
  }
  saveEmployees();
  closeModal(null);
  renderStaff();
  refreshDashboard();
  renderIDCards();
}

function delStaff(id) {
  if (!confirm(`Delete staff record "${id}"? This cannot be undone.`)) return;
  STATE.employees = STATE.employees.filter(g => g.id !== id);
  saveEmployees();
  renderStaff();
  refreshDashboard();
  renderIDCards();
  toast('Staff record removed.');
}

// ─── Users ────────────────────────────────────────────────────────
function renderUsers() {
  const tbody = $('u-tbody');
  const empty = $('u-empty');
  if (!STATE.users.length) {
    if (tbody) tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = STATE.users.map(u => `<tr>
    <td><div class="guard-cell">
      <div class="g-avatar" style="background:var(--indigo-l);display:flex;align-items:center;justify-content:center;color:var(--indigo);font-weight:800;font-size:.8rem">${esc((u.username||'?')[0].toUpperCase())}</div>
      <div><span class="g-name">${esc(u.username)}</span><span class="g-role-sm">${esc(u.displayName||'—')}</span></div>
    </div></td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:.74rem;color:#64748b">${esc(u.username)}</td>
    <td><span class="chip chip-guard">${capitalise(u.role||'scanner')}</span></td>
    <td>${esc(u.linkedEmp||'—')}</td>
    <td><div class="tbl-acts">
      <button class="tbl-btn edit" onclick="openUserModal('${esc(u.id)}')" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="tbl-btn del" onclick="delUser('${esc(u.id)}')" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg></button>
    </div></td>
  </tr>`).join('');
}

function openUserModal(userId) {
  $('um-err').classList.add('hidden');
  // Populate recent 10 employees dropdown
  const sel = $('um-employee');
  sel.innerHTML = '<option value="">-- None --</option>';
  const recent = [...STATE.employees].sort((a,b)=>new Date(b.addedAt)-new Date(a.addedAt)).slice(0,10);
  recent.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.name} (${e.id})`;
    sel.appendChild(opt);
  });

  if (userId) {
    const u = STATE.users.find(x => x.id === userId);
    if (!u) return;
    $('user-modal-title').textContent = 'Edit User';
    $('um-orig-id').value = u.id;
    $('um-username').value = u.username;
    $('um-password').value = u.password;
    $('um-role').value = u.role||'scanner';
    $('um-employee').value = u.linkedEmp||'';
  } else {
    $('user-modal-title').textContent = 'Add User Account';
    $('um-orig-id').value = '';
    $('um-username').value = '';
    $('um-password').value = '';
    $('um-role').value = 'scanner';
    $('um-employee').value = '';
  }
  $('user-modal-overlay').classList.remove('hidden');
}

function closeUserModal(e) {
  if (e && e.target !== $('user-modal-overlay')) return;
  $('user-modal-overlay').classList.add('hidden');
}

function saveUser() {
  const username = $('um-username').value.trim();
  const password = $('um-password').value;
  const errEl = $('um-err');
  if (!username || !password) { errEl.classList.remove('hidden'); return; }
  errEl.classList.add('hidden');
  const origId = $('um-orig-id').value;
  const isEdit = Boolean(origId);
  const linkedEmpId = $('um-employee').value;
  const linkedEmp = STATE.employees.find(e => e.id === linkedEmpId);
  const userData = {
    id:          isEdit ? origId : genId('USR'),
    username, password,
    role:        $('um-role').value,
    linkedEmp:   linkedEmpId,
    displayName: linkedEmp ? linkedEmp.name : username,
  };
  if (isEdit) {
    const i = STATE.users.findIndex(u => u.id === origId);
    if (i !== -1) STATE.users[i] = userData;
    toast('✓ User updated.');
  } else {
    if (STATE.users.find(u => u.username === username)) {
      errEl.textContent = `Username "${username}" already exists.`;
      errEl.classList.remove('hidden'); return;
    }
    STATE.users.push(userData);
    toast('✓ User added.');
  }
  saveUsers();
  closeUserModal(null);
  renderUsers();
  renderPermList();
}

function delUser(id) {
  if (!confirm('Delete this user account?')) return;
  STATE.users = STATE.users.filter(u => u.id !== id);
  saveUsers();
  renderUsers();
  renderPermList();
  toast('User removed.');
}

// ─── Designations ─────────────────────────────────────────────────
function populateDesigSelect(selectId) {
  const sel = $(selectId);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = STATE.designations.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (current) sel.value = current;
}

function renderDesigList() {
  const container = $('desig-list');
  if (!container) return;
  container.innerHTML = STATE.designations.map((d, i) => `
    <span class="desig-chip">
      ${esc(d)}
      <button onclick="removeDesignation(${i})" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </span>
  `).join('');
}

function addDesignation() {
  const inp = $('desig-input');
  const val = inp.value.trim();
  if (!val) return;
  if (STATE.designations.find(d => d.toLowerCase() === val.toLowerCase())) {
    toast('Designation already exists.'); return;
  }
  STATE.designations.push(val);
  saveDesigs();
  renderDesigList();
  inp.value = '';
  toast(`✓ "${val}" added.`);
}

function removeDesignation(idx) {
  STATE.designations.splice(idx, 1);
  saveDesigs();
  renderDesigList();
}

// ─── Settings ─────────────────────────────────────────────────────
function saveCreds() {
  const u = $('s-user').value.trim();
  const p = $('s-pass').value;
  if (!u && !p) { toast('Enter new username or password.'); return; }
  const creds = getCreds();
  if (u) creds.admin.username = u;
  if (p) creds.admin.password = p;
  setLocal(K.creds, creds);
  $('s-user').value = '';
  $('s-pass').value = '';
  toast('✓ Credentials saved.');
}

function renderPermList() {
  const container = $('perm-list');
  if (!container) return;
  if (!STATE.users.length) { container.innerHTML = '<p class="empty-msg" style="padding:12px">No user accounts yet.</p>'; return; }
  container.innerHTML = STATE.users.map(u => `
    <div class="perm-item">
      <div>
        <div class="perm-item-name">${esc(u.username)}</div>
        <div class="perm-item-role">${esc(u.displayName||'—')}</div>
      </div>
      <select class="perm-select" onchange="updateUserPerm('${esc(u.id)}', this.value)">
        <option value="scanner" ${u.role==='scanner'?'selected':''}>Scanner Only</option>
        <option value="supervisor" ${u.role==='supervisor'?'selected':''}>Field Supervisor</option>
        <option value="control-room" ${u.role==='control-room'?'selected':''}>Control Room</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
      </select>
    </div>
  `).join('');
}

function updateUserPerm(uid, role) {
  const u = STATE.users.find(x => x.id === uid);
  if (u) { u.role = role; saveUsers(); toast('✓ Permission updated.'); }
}

// ─── Reports ──────────────────────────────────────────────────────
function renderReport(cat) {
  const container = $('rep-'+cat+'-content');
  if (!container) return;

  const d = new Date();
  const localToday = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  if (!($('rep-tbody-'+cat))) {
    container.innerHTML = `
      <div class="rep-filter-bar" style="display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:center;">
        <div class="search-box" style="flex:1; min-width:180px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="r-search-${cat}" class="toolbar-input" placeholder="Search guard name or ID..." oninput="renderReport('${cat}')" />
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="date" id="r-date-${cat}" class="toolbar-select" onchange="renderReport('${cat}')" value="${localToday}" />
          <select id="r-limit-${cat}" class="toolbar-select" onchange="renderReport('${cat}')">
            <option value="20">Show 20</option>
            <option value="50">Show 50</option>
            <option value="100">Show 100</option>
            <option value="all" selected>Show All</option>
          </select>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Date &amp; Time</th><th>Employee ID</th><th>Name</th><th>Post / Sector</th><th>Status at Scan</th><th>Scanned By</th></tr></thead>
          <tbody id="rep-tbody-${cat}"></tbody>
        </table>
        <p class="empty-msg" id="rep-empty-${cat}" style="display:none;padding:32px">No records found.</p>
      </div>
    `;
  }

  let logs = STATE.logs.filter(l => (l.category||'guard') === cat);

  const q  = ($('r-search-'+cat)?.value||'').toLowerCase();
  const df = $('r-date-'+cat)?.value||'';
  const limitVal = $('r-limit-'+cat)?.value || 'all';

  if (q)  logs = logs.filter(l => (l.guardName||'').toLowerCase().includes(q)||(l.guardId||'').toLowerCase().includes(q));
  if (df) {
    logs = logs.filter(l => {
      const ld = new Date(l.timestamp);
      const logLocalDate = `${ld.getFullYear()}-${String(ld.getMonth()+1).padStart(2,'0')}-${String(ld.getDate()).padStart(2,'0')}`;
      return logLocalDate === df;
    });
  }

  if (limitVal !== 'all') {
    const limit = parseInt(limitVal, 10);
    logs = logs.slice(0, limit);
  }

  const tbody = $('rep-tbody-'+cat);
  const empty = $('rep-empty-'+cat);
  if (!tbody) return;

  if (!logs.length) {
    tbody.innerHTML = '';
    if (empty) {
      empty.textContent = "No records found.";
      empty.style.display = 'block';
    }
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = logs.map(l => `<tr>
    <td style="font-family:'JetBrains Mono',monospace;font-size:.74rem;white-space:nowrap">${fmtDT(l.timestamp)}</td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:.74rem;color:#64748b">${esc(l.guardId)}</td>
    <td>${esc(l.guardName||'—')}</td>
    <td>${esc(l.sector||'—')}</td>
    <td><span class="chip ${l.statusAtScan==='On-Duty'?'chip-on':'chip-off'}">${esc(l.statusAtScan||'—')}</span></td>
    <td style="color:#64748b;font-size:.78rem">${esc(l.scannedBy||'—')}</td>
  </tr>`).join('');
}

function exportCSV(cat) {
  const logs = STATE.logs.filter(l => (l.category||'guard') === cat);
  if (!logs.length) { toast('No logs to export.'); return; }
  const hdr = ['Timestamp','Guard ID','Guard Name','Assigned Post','Status at Scan','Scanned By'];
  const rows = logs.map(l => [fmtDT(l.timestamp),l.guardId,l.guardName||'',l.sector||'',l.statusAtScan||'',l.scannedBy||''].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  dlFile(`VerifyOne_${capitalise(cat)}_Logs_${new Date().toISOString().slice(0,10)}.csv`, [hdr.join(','),...rows].join('\r\n'), 'text/csv');
  toast(`✓ ${capitalise(cat)} CSV exported.`);
}

// ─── QR Scanner ───────────────────────────────────────────────────
function startScanner() {
  if (scanRunning) return;
  qrScanner = new Html5Qrcode('qr-reader');
  Html5Qrcode.getCameras().then(cams => {
    if (!cams || !cams.length) return;
    const cam = cams.find(c => /back|rear|env/i.test(c.label)) || cams[cams.length-1];
    qrScanner.start(cam.id, { fps:12, qrbox:{width:200,height:200} }, onScanSuccess, ()=>{})
      .then(() => { scanRunning=true; })
      .catch(() => {});
  }).catch(() => {});
}

function stopScanner() {
  if (qrScanner && scanRunning) { qrScanner.stop().catch(()=>{}); scanRunning=false; }
  if (flashActive) { toggleFlash(); }
}

function onScanSuccess(txt) {
  stopScanner();
  lookupEmployee(txt.trim());
}

function manualLookup() {
  const v = $('manual-id-input').value.trim();
  if (!v) { toast('Please enter an Employee ID.'); return; }
  stopScanner();
  lookupEmployee(v);
}

function lookupEmployee(rawId) {
  $('result-card').classList.add('hidden');
  $('not-found-card').classList.add('hidden');
  const emps = STATE.employees;
  const g = emps.find(x => x.id.toLowerCase() === rawId.toLowerCase());
  if (g) {
    // Shift time enforcement
    let effectiveStatus = g.status;
    if (g.shiftStart && g.shiftEnd) {
      const now = new Date();
      const [sh, sm] = g.shiftStart.split(':').map(Number);
      const [eh, em] = g.shiftEnd.split(':').map(Number);
      const nowMins  = now.getHours()*60 + now.getMinutes();
      const startMin = sh*60 + sm;
      const endMin   = eh*60 + em;
      const inShift  = startMin <= endMin ? (nowMins >= startMin && nowMins <= endMin)
                                           : (nowMins >= startMin || nowMins <= endMin);
      if (!inShift) effectiveStatus = 'Off-Duty';
    }
    if (navigator.vibrate) navigator.vibrate([60,30,60]);
    const entry = {
      id:             genId('LOG'),
      timestamp:      new Date().toISOString(),
      guardId:        g.id,
      guardName:      g.name,
      category:       g.category||'guard',
      scannedBy:      currentSession?.username||'Field User',
      sector:         g.sector||'—',
      statusAtScan:   effectiveStatus,
    };
    STATE.logs.unshift(entry);
    saveLogs();
    showResult(g, effectiveStatus);
  } else {
    $('nf-scanned-id').textContent = `Scanned ID: "${rawId}"`;
    $('not-found-card').classList.remove('hidden');
  }
}

function showResult(g, effectiveStatus) {
  const isOn = effectiveStatus === 'On-Duty';
  const hdr = $('res-header');
  hdr.className = 'res-header ' + (isOn ? 'verified' : 'off-duty');
  $('res-header-icon').innerHTML = isOn
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  $('res-status-title').textContent = isOn ? 'VERIFIED – ON DUTY' : 'ALERT – OFF DUTY / OUTSIDE SHIFT';
  $('res-scan-time').textContent = fmtDT(new Date().toISOString());

  const img = $('res-photo');
  img.src = g.photo || PLACEHOLDER;
  img.onerror = () => { img.src = PLACEHOLDER; };

  const chip = $('res-duty-chip');
  chip.textContent = effectiveStatus;
  chip.className = 'res-duty-chip ' + (isOn ? 'on' : 'off');

  $('res-name').textContent     = g.name;
  $('res-emp-id').textContent   = g.id;
  $('res-role').textContent     = g.role||'—';
  $('res-shift').textContent    = g.shift||'—';
  $('res-sector').textContent   = g.sector||'—';
  $('res-category').textContent = capitalise(g.category||'guard');
  $('res-log-time').textContent = fmtT(new Date().toISOString());

  $('result-card').classList.remove('hidden');
}

function resetScanner() {
  $('result-card').classList.add('hidden');
  $('not-found-card').classList.add('hidden');
  $('manual-id-input').value = '';
  startScanner();
}

function tickScannerTime() {
  const el = $('topbar-time');
  const tick = () => el.textContent = new Date().toLocaleTimeString('en-PK',{hour:'2-digit',minute:'2-digit',hour12:true});
  tick(); setInterval(tick, 15000);
}

// ─── Flashlight ───────────────────────────────────────────────────
async function toggleFlash() {
  const btn = $('flash-btn');
  try {
    if (!activeStream) {
      activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    }
    const track = activeStream.getVideoTracks()[0];
    if (!track) return;
    flashActive = !flashActive;
    await track.applyConstraints({ advanced: [{ torch: flashActive }] });
    btn.classList.toggle('active', flashActive);
    toast(flashActive ? '🔦 Flashlight ON' : 'Flashlight OFF', 1500);
  } catch(e) {
    toast('Flashlight not supported on this device.', 2000);
  }
}

// ─── ID Cards ─────────────────────────────────────────────────────
function renderIDCards() {
  const grid = $('id-cards-grid');
  if (!grid) return;
  const q = ($('ic-search')?.value||'').toLowerCase();
  let emps = [...STATE.employees];
  if (q) emps = emps.filter(e => e.name.toLowerCase().includes(q)||e.id.toLowerCase().includes(q));
  if (!emps.length) { grid.innerHTML = '<p class="empty-msg">No staff records found.</p>'; return; }
  grid.innerHTML = emps.map(g => `
    <div class="ic-card">
      <img class="ic-photo" src="${esc(g.photo||PLACEHOLDER)}" onerror="this.src='${PLACEHOLDER}'" alt="${esc(g.name)}" />
      <div class="ic-name">${esc(g.name)}</div>
      <div class="ic-empid">${esc(g.id)}</div>
      <div class="ic-qr">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(g.id)}&bgcolor=ffffff&color=1D4CA1" alt="QR" />
      </div>
      <div class="ic-actions">
        <button class="tbl-btn qr" onclick="showQR('${esc(g.id)}')" title="View QR">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </button>
        <button class="tbl-btn print" onclick="printCard('${esc(g.id)}')" title="Print Card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function showQR(empId) {
  const g = STATE.employees.find(x => x.id === empId);
  if (!g) return;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(g.id)}&bgcolor=ffffff&color=1D4CA1`;
  const win = window.open('', '_blank', 'width=360,height=430');
  win.document.write(`<!DOCTYPE html><html><head><title>QR – ${g.id}</title>
  <style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:Inter,sans-serif;background:#f8fafc;}
  h2{font-size:1rem;color:#1D4CA1;margin-bottom:4px;} p{font-size:.75rem;color:#64748b;margin-bottom:20px;font-family:monospace;}
  img{border:4px solid #1D4CA1;border-radius:12px;padding:10px;background:#fff;}
  </style></head><body>
  <h2>${g.name}</h2><p>${g.id}</p>
  <img src="${qrUrl}" alt="QR Code" />
  </body></html>`);
}

function printCard(empId) {
  const g = STATE.employees.find(x => x.id === empId);
  if (!g) { toast('Employee not found.'); return; }
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=65x65&data=${encodeURIComponent(g.id)}&bgcolor=ffffff&color=1D4CA1`;
  const issueDate  = g.issue  ? new Date(g.issue).toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-') : '—';
  const expiryDate = g.expiry ? new Date(g.expiry).toLocaleDateString('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'}).replace(/\//g,'-') : '—';
  const photoSrc = g.photo || 'https://via.placeholder.com/135x165?text=Photo';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>ID Card – ${g.name}</title>
<style>
@page{size:85.6mm 53.98mm;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,Helvetica,sans-serif;background:#e8eaed;display:flex;gap:20px;justify-content:center;align-items:center;padding:20px;flex-wrap:wrap;min-height:100vh;}
.id-card{width:320px;height:500px;background:#ffffff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);position:relative;overflow:hidden;border:1px solid #dcdcdc;}
.logo-box{position:absolute;top:0;left:50%;transform:translateX(-50%);background:#fff;display:flex;align-items:center;padding:6px 14px;z-index:10;}
.logo-main{font-weight:900;font-size:20px;color:#1D4CA1;letter-spacing:-0.5px;display:flex;flex-direction:column;line-height:1;margin-right:8px;}
.logo-sub{font-size:7px;font-weight:bold;color:#1D4CA1;letter-spacing:.5px;margin-top:2px;}
.logo-icon-box{background:#F4B215;padding:3px 5px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:2px;}
.logo-icon-svg{width:18px;height:12px;}
.logo-icon-text{font-size:6px;font-weight:bold;color:#fff;margin-top:2px;}
.front-bg-blue{position:absolute;top:0;left:0;width:100%;height:220px;background:#1D4CA1;clip-path:polygon(0 0,100% 0,100% 65%,50% 100%,0 65%);z-index:1;}
.front-bg-navy{position:absolute;top:0;left:0;width:100%;height:190px;background:#17202A;clip-path:polygon(0 0,100% 0,100% 50%,50% 85%,0 50%);z-index:2;}
.profile-container{position:absolute;top:100px;left:50%;transform:translateX(-50%);z-index:5;width:135px;height:165px;background:#fff;padding:2px;box-shadow:0 4px 10px rgba(0,0,0,.15);}
.profile-img{width:135px;height:165px;object-fit:cover;background:#eaeaea;display:block;}
.info-section{position:absolute;top:280px;width:100%;padding:0 20px;text-align:center;z-index:5;}
.emp-name{font-size:20px;font-weight:bold;color:#222;margin-bottom:2px;}
.designation{font-size:13px;font-weight:bold;color:#555;letter-spacing:.5px;text-transform:uppercase;margin-bottom:15px;}
.data-qr-wrapper{display:flex;justify-content:space-between;align-items:center;text-align:left;}
.data-table{font-size:11px;line-height:1.8;color:#333;width:65%;}
.data-table span{font-weight:bold;display:inline-block;width:55px;color:#444;}
.qr-box{width:65px;height:65px;background:#fff;border:1px solid #ccc;padding:2px;}
.qr-box img{width:100%;height:100%;display:block;}
.dates-row{display:flex;justify-content:space-between;margin-top:15px;padding-top:8px;border-top:1px solid #eee;font-size:10px;font-weight:bold;color:#444;}
.bottom-left-accent{position:absolute;bottom:0;left:0;width:30px;height:30px;background:#1D4CA1;clip-path:polygon(0 0,0 100%,100% 100%);z-index:3;}
.bottom-right-accent{position:absolute;bottom:0;right:0;width:30px;height:30px;background:#1D4CA1;clip-path:polygon(100% 0,0 100%,100% 100%);z-index:3;}
/* Back */
.id-card-back{background:#fff;padding:20px;display:flex;flex-direction:column;justify-content:space-between;}
.terms-title{font-size:14px;font-weight:bold;color:#222;text-align:center;margin-bottom:12px;}
.terms-text{font-size:8px;line-height:1.4;color:#333;margin:0;padding:0;list-style-type:none;}
.terms-text li{margin-bottom:5px;text-align:justify;}
.emergency-box{text-align:center;font-size:11px;font-weight:bold;color:#111;margin-top:10px;}
.emergency-phone{font-size:12px;color:#1D4CA1;margin-top:2px;}
.back-graphic-container{position:relative;height:120px;background:#17202A;margin:10px -20px -20px -20px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:20px;}
.back-chevron-white{position:absolute;top:0;left:0;width:100%;height:35px;background:#fff;clip-path:polygon(0 0,100% 0,100% 15%,50% 100%,0 15%);z-index:1;}
.back-chevron-blue{position:absolute;top:6px;left:0;width:100%;height:40px;background:#1D4CA1;clip-path:polygon(0 0,100% 0,50% 100%);z-index:0;}
.back-logo-wrapper{z-index:2;transform:scale(.85);background:#fff;padding:5px 10px;}
@media print{body{background:none;padding:0;gap:10mm;}@page{size:85.6mm 53.98mm;margin:0;}.id-card{page-break-after:always;box-shadow:none;border:none;}}
</style></head><body>
<div class="id-card">
  <div class="logo-box">
    <div class="logo-main">MUNCK<span class="logo-sub">CIVIL ENGINEERING</span></div>
    <div class="logo-icon-box">
      <svg class="logo-icon-svg" viewBox="0 0 24 16"><path d="M2,14 L6,2 L18,2 L22,14 Z" fill="none" stroke="#1D4CA1" stroke-width="2.5"/><path d="M12,2 L12,14" stroke="#ffffff" stroke-width="2" stroke-dasharray="3,2"/></svg>
      <span class="logo-icon-text">MUNCK</span>
    </div>
  </div>
  <div class="front-bg-blue"></div>
  <div class="front-bg-navy"></div>
  <div class="profile-container"><img src="${photoSrc}" alt="Photo" class="profile-img" /></div>
  <div class="info-section">
    <div class="emp-name">${esc(g.name)}</div>
    <div class="designation">${esc(g.role||'—')}</div>
    <div class="data-qr-wrapper">
      <div class="data-table">
        <div><span>Emp No.</span>: ${esc(g.id)}</div>
        <div><span>CNIC</span>: ${esc(g.cnic||'—')}</div>
        <div><span>DOB</span>: ${esc(g.dob||'—')}</div>
        <div><span>Phone</span>: ${esc(g.phone||'—')}</div>
      </div>
      <div class="qr-box"><img src="${qrUrl}" alt="QR" /></div>
    </div>
    <div class="dates-row">
      <div>Date of Issue: ${issueDate}</div>
      <div>Date of Expiry: ${expiryDate}</div>
    </div>
  </div>
  <div class="bottom-left-accent"></div>
  <div class="bottom-right-accent"></div>
</div>

<div class="id-card id-card-back">
  <div>
    <div class="terms-title">Terms &amp; Conditions</div>
    <ul class="terms-text">
      <li>• This card is non-transferable and must not be used by any other person.</li>
      <li>• Loss of the card must be reported immediately to Security or Administration.</li>
      <li>• Unauthorized entry into restricted areas is strictly prohibited.</li>
      <li>• The cardholder must follow all company HSE and security rules.</li>
      <li>• Misuse of this card may result in disciplinary action or cancellation of site access.</li>
      <li>• The card must be returned upon resignation, termination, or project completion.</li>
      <li>• Management reserves the right to cancel or confiscate the card at any time.</li>
      <li>• Entry to the site is subject to compliance with safety requirements and valid authorization.</li>
    </ul>
    <div class="emergency-box">In case of any Emergency call on<div class="emergency-phone">0323-7920912</div></div>
  </div>
  <div class="back-graphic-container">
    <div class="back-chevron-white"></div>
    <div class="back-chevron-blue"></div>
    <div class="back-logo-wrapper">
      <div style="display:flex;align-items:center;">
        <div class="logo-main" style="margin-right:8px;">MUNCK<span class="logo-sub">CIVIL ENGINEERING</span></div>
        <div class="logo-icon-box">
          <svg class="logo-icon-svg" viewBox="0 0 24 16"><path d="M2,14 L6,2 L18,2 L22,14 Z" fill="none" stroke="#1D4CA1" stroke-width="2.5"/><path d="M12,2 L12,14" stroke="#ffffff" stroke-width="2" stroke-dasharray="3,2"/></svg>
          <span class="logo-icon-text">MUNCK</span>
        </div>
      </div>
    </div>
  </div>
</div>
<script>window.onload=()=>{setTimeout(()=>{window.print();},600);};<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

// ─── Backup / Restore ─────────────────────────────────────────────
function exportBackup() {
  const data = { exported:new Date().toISOString(), version:'3.0', employees:STATE.employees, logs:STATE.logs, users:STATE.users, designations:STATE.designations };
  dlFile('VerifyOne_Backup_'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(data,null,2), 'application/json');
  toast('✓ Backup exported.');
}

function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (!Array.isArray(d.employees)) throw 0;
      if (confirm(`Restore backup from ${new Date(d.exported).toLocaleDateString()}? Current data will be replaced.`)) {
        STATE.employees    = d.employees;
        STATE.logs         = d.logs || [];
        STATE.users        = d.users || [];
        STATE.designations = d.designations || DEFAULT_DESIGNATIONS;
        saveEmployees(); saveLogs(); saveUsers(); saveDesigs();
        renderStaff(); renderUsers(); refreshDashboard();
        renderReport('labour'); renderReport('guard'); renderReport('visitor');
        renderIDCards(); renderDesigList(); renderPermList();
        toast('✓ Backup restored.');
      }
    } catch { toast('❌ Invalid backup file.'); }
  };
  r.readAsText(file);
  e.target.value = '';
}

// ─── Utilities ────────────────────────────────────────────────────
function dlFile(name, content, mime) {
  const b = new Blob([content],{type:mime});
  const u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href=u; a.download=name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(u);
}

function capitalise(str) {
  if (!str) return '';
  const map = { 'labour':'Labour','guard':'Guard Force','visitor':'Visitor','scanner':'Scanner','supervisor':'Supervisor','control-room':'Control Room','admin':'Admin','master':'Master' };
  return map[str] || str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Seed Data ────────────────────────────────────────────────────
function seedSampleData() {
  if (STATE.employees.length) return;
  STATE.employees = [
    {id:'EMP-1001',name:'Muhammad Ali',      cnic:'35202-1234567-1',phone:'+92 300 1111111',dob:'1990-05-14',category:'guard',   role:'Guard',      shift:'Day',   shiftStart:'08:00',shiftEnd:'20:00',sector:'Main Gate – Sector A', weapon:'Armed (Baton)', status:'On-Duty',  photo:'',issue:'2026-01-01',expiry:'2028-01-01',addedAt:new Date().toISOString()},
    {id:'EMP-1002',name:'Asad Khan',         cnic:'35202-2345678-2',phone:'+92 300 2222222',dob:'1988-03-22',category:'guard',   role:'Supervisor', shift:'Day',   shiftStart:'08:00',shiftEnd:'20:00',sector:'Control Room',          weapon:'Armed (Pistol)',status:'On-Duty',  photo:'',issue:'2026-01-01',expiry:'2028-01-01',addedAt:new Date().toISOString()},
    {id:'EMP-1003',name:'Bilal Mahmood',     cnic:'35202-3456789-3',phone:'+92 300 3333333',dob:'1995-11-08',category:'labour',  role:'Mason',      shift:'Day',   shiftStart:'07:00',shiftEnd:'17:00',sector:'Block B – Construction', weapon:'Unarmed',       status:'On-Duty',  photo:'',issue:'2026-01-01',expiry:'2028-06-01',addedAt:new Date().toISOString()},
    {id:'EMP-1004',name:'Zeeshan Ahmed',     cnic:'35202-4567890-4',phone:'+92 300 4444444',dob:'1992-07-30',category:'guard',   role:'QRF',        shift:'24-Hour',shiftStart:'',shiftEnd:'',sector:'QRF Standby',           weapon:'Armed (AK-47)', status:'On-Duty',  photo:'',issue:'2026-01-01',expiry:'2028-01-01',addedAt:new Date().toISOString()},
    {id:'EMP-1005',name:'Tariq Mehmood',     cnic:'35202-5678901-5',phone:'+92 300 5555555',dob:'1993-02-17',category:'labour',  role:'Electrician',shift:'Day',   shiftStart:'08:00',shiftEnd:'17:00',sector:'Sector C – Wiring',      weapon:'Unarmed',       status:'Off-Duty', photo:'',issue:'2026-01-01',expiry:'2028-01-01',addedAt:new Date().toISOString()},
    {id:'VIS-2001', name:'Ahmed Visitor',    cnic:'',phone:'+92 301 0000001',dob:'',category:'visitor', role:'Visitor',    shift:'Day',   shiftStart:'09:00',shiftEnd:'17:00',sector:'Admin Office',           weapon:'Unarmed',       status:'On-Duty',  photo:'',issue:'2026-06-08',expiry:'2026-06-08',addedAt:new Date().toISOString()},
  ];
  saveEmployees();
}

// ─── Init ─────────────────────────────────────────────────────────
(function init() {
  // Load local data first
  loadAll();
  // Seed if empty
  seedSampleData();
  // Try Firebase
  initFirebase();
  // Start quote rotator
  startQuoteRotator();

  // Restore session (persists across refresh)
  if (restoreSession()) {
    enterApp(currentSession.role);
  } else {
    showScreen('screen-login');
  }

  // Set today's local date in report date filters
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  ['labour','guard','visitor'].forEach(cat => {
    const el = $('r-date-'+cat);
    if (el) el.value = today;
  });
})();
