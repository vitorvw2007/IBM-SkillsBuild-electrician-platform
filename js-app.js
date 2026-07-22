/**
 * MAIN APPLICATION (js-app.js)
 * ----------------------------------------------------------------------------
 * The controller for the whole electrician dispatch app. It owns:
 *   - State + persistence: the single `appState` object, mirrored into a
 *     per-user Supabase row (requests / settings / purchase columns) once
 *     signed in. See window.App.onSignedIn/onSignedOut and loadData/saveData,
 *     loadSettings/persistSettings, loadPurchase/savePurchase.
 *   - CSV import: parse a customer-request CSV, run each row through the offline
 *     InferenceEngine, and (optionally) re-classify every row with the AI provider.
 *   - Screens: Requests board, Scheduled services, Purchase list, and the job
 *     detail page, all rendered by hand into #overview / #detail / #purchase.
 *   - Scheduling: proposing windows, an urgency + driving-distance auto-planner
 *     (greedy insertion, optional 2-opt), and the booking-email / decline flow.
 *   - Purchase list: aggregating materials from scheduled jobs and requesting AI
 *     price/store recommendations.
 *
 * No build step, no framework; plain vanilla JS. Auth + storage are handled by
 * Supabase (see js-auth.js and supabase-config.js).
 *
 * Depends on the sibling scripts loaded before it in index.html: Auth (session +
 * login screen), InferenceEngine (offline classifier), AIProvider (network layer),
 * AIEnrichment (AI re-classification).
 */


// ============ STATE MANAGEMENT ============
// The entire app state lives in this single object. Each top-level slice is
// persisted to the signed-in user's Supabase row so a reload restores exactly this shape.
let appState = {
  requests: [],
  settings: {
    businessName: 'Your Electric Company',
    baseAddress: '',
    baseCoordinates: null,
    businessHours: '8:00 AM - 5:00 PM',
    businessStartHour: 8,
    businessEndHour: 17,
    dailyCapHours: 8.5,
    lunchEnabled: false,
    lunchStart: '12:00',
    lunchEnd: '13:00',
    // Scheduling target windows (working days) by priority, user-editable.
    deadlineHighDays: 1,
    deadlineMediumDays: 3,
    deadlineLowDays: 7,
    deadlineNonRepairDays: 14,
    // Whether the auto-planner may re-time already-confirmed bookings.
    allowMoveBooked: false,
    // AI provider config (any provider supported via AIProvider). Stored per-account.
    aiProvider: '',
    aiApiKey: '',
    aiModel: '',
    aiBaseUrl: '',
    aiProxyUrl: '',
    aiProjectId: '',
    sortBy: 'date-asc'
  },
  calendar: [],
  currentScreen: 'overview',
  // Purchase list state, persisted to the user's Supabase row. qty/inStock/units are
  // keyed by normalized material name; from/to are YYYY-MM-DD; prefs/recommendation
  // hold the AI shopping options and last result.
  purchase: { qty: {}, inStock: {}, units: {}, from: null, to: null, prefs: { maxStores: 2, delivery: 'any', location: '', storeSort: 'cheapest' }, recommendation: null }
};


// Whether an AI provider + key are configured (and a base URL when the provider needs one).
function aiConfigured() {
  const s = appState.settings;
  if (!s.aiProvider || !s.aiApiKey) return false;
  const def = AIProvider.get(s.aiProvider);
  if (def && def.needsBaseUrl && !(s.aiBaseUrl && s.aiBaseUrl.trim())) return false;
  if (def && def.needsProjectId && !(s.aiProjectId && s.aiProjectId.trim())) return false;
  return true;
}


// The provider config object the AI layer expects.
function aiConfig() {
  const s = appState.settings;
  return { provider: s.aiProvider, apiKey: s.aiApiKey, model: s.aiModel, baseUrl: s.aiBaseUrl, proxyUrl: s.aiProxyUrl, projectId: s.aiProjectId };
}


// Spacing and travel constants (buffer and lunch are excluded from the daily cap)
const BUFFER_MINUTES = 15;
const SCHEDULE_HORIZON_DAYS = 14;
const SLOT_GRANULARITY_MINUTES = 15;
const PLACEHOLDER_WINDOW_HOURS = 1;


// Monotonic counter so request ids stay unique even across appends in the same
// millisecond. Combined with the timestamp, ids never collide within or across imports.
let _idCounter = 0;
function makeRequestId() {
  return `req_${Date.now()}_${_idCounter++}`;
}


// Find a job by id, tolerating string/number id mismatches (inline onclick handlers
// pass ids as strings, so both sides are compared as strings).
function findJob(id) {
  return appState.requests.find(x => String(x.id) === String(id));
}


// ============ INITIALIZATION ============
// Static UI wiring happens immediately; loading the user's data waits for a
// confirmed Supabase session (see js-auth.js, which calls window.App.onSignedIn).
document.addEventListener('DOMContentLoaded', () => {
  initializeEventListeners();
});


// The signed-in user's id, and a local cache of their Supabase row (requests /
// settings / purchase), so loadSettings/loadData/loadPurchase don't each need
// a network round trip. Populated by window.App.onSignedIn (via ensureUserRow),
// cleared on sign-out.
let currentUserId = null;
let _userRow = null;


// Fetch the signed-in user's row, creating a blank default row on first login.
async function ensureUserRow(userId) {
  const { data, error } = await Auth.client.from('user_data').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: inserted, error: insertError } = await Auth.client
    .from('user_data').insert({ user_id: userId }).select().single();
  if (insertError) throw insertError;
  return inserted;
}


// Called by js-auth.js once Supabase confirms a session.
window.App = window.App || {};
window.App.onSignedIn = async function (user) {
  currentUserId = user.id;
  try {
    _userRow = await ensureUserRow(currentUserId);
  } catch (err) {
    console.error('Failed to load your account data', err);
    alert('Could not load your saved data. Check your connection and reload the page.');
    return;
  }
  await loadSettings();
  await loadData();
  await loadPurchase();
  // These controls were populated/set before login (at DOMContentLoaded), against
  // default settings; re-sync them now that the real settings have loaded.
  document.getElementById('aiProvider').value = appState.settings.aiProvider || '';
  document.getElementById('sortSelect').value = appState.settings.sortBy;
  updateAiProviderHints();
  updateUI();
};


// Called by js-auth.js after sign-out. Resets in-memory state so a different
// account logging in on the same browser never sees the previous user's data.
window.App.onSignedOut = function () {
  currentUserId = null;
  _userRow = null;
  appState.requests = [];
  appState.calendar = [];
  appState.currentScreen = 'overview';
  appState.purchase = { qty: {}, inStock: {}, units: {}, from: null, to: null, prefs: { maxStores: 2, delivery: 'any', location: '', storeSort: 'cheapest' }, recommendation: null };
};


// Tracks the open detail page so Back and settings re-render can return correctly.
let currentDetailId = null;
let detailOriginScreen = 'overview';
// The job currently being scheduled in the schedule modal.
let schedulingJobId = null;


// Wire up every static control once, at startup (called from DOMContentLoaded). This
// covers the nav tabs, the settings/base chip, the "Add Requests" menus, CSV import,
// export, auto-schedule, and populating the AI-provider dropdown from AIProvider.list().
function initializeEventListeners() {
  document.getElementById('baseChip').addEventListener('click', () => openModal('settingsModal'));
  document.getElementById('baseChip').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal('settingsModal');
    }
  });
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('autoScheduleBtn').addEventListener('click', autoScheduleAll);
  document.getElementById('navRequests').addEventListener('click', () => goToScreen('overview'));
  document.getElementById('navScheduled').addEventListener('click', () => goToScreen('scheduled'));
  document.getElementById('navPurchase').addEventListener('click', () => goToScreen('purchase'));
  document.getElementById('navSettings').addEventListener('click', () => openModal('settingsModal'));
  document.getElementById('schedSuggestBtn').addEventListener('click', applySuggestedWindow);

  // AI provider dropdown: populate options, then re-apply the saved value (loadSettings
  // ran before these options existed) and refresh the per-provider hints.
  const aiProviderEl = document.getElementById('aiProvider');
  AIProvider.list().forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    aiProviderEl.appendChild(opt);
  });
  aiProviderEl.value = appState.settings.aiProvider || '';
  aiProviderEl.addEventListener('change', updateAiProviderHints);
  updateAiProviderHints();

  // Sort control on the Requests board
  const sortSelect = document.getElementById('sortSelect');
  sortSelect.value = appState.settings.sortBy;
  sortSelect.addEventListener('change', () => {
    appState.settings.sortBy = sortSelect.value;
    persistSettings();
    renderRows(currentList());
  });

  // "Add Requests" dropdown menu
  document.getElementById('addRequestsBtn').addEventListener('click', toggleAddRequestsMenu);
  document.getElementById('menuImportCsv').addEventListener('click', () => {
    closeAddRequestsMenu();
    openModal('importModal');
  });
  document.getElementById('menuClearRequests').addEventListener('click', () => {
    closeAddRequestsMenu();
    clearRequests();
  });
  document.getElementById('menuConnectForm').addEventListener('click', () => {
    closeAddRequestsMenu();
    connectToForm();
  });
  // Same menu inside the empty state (no Clear option, since there is nothing to clear).
  document.getElementById('addRequestsBtnEmpty').addEventListener('click', toggleAddRequestsMenuEmpty);
  document.getElementById('menuImportCsvEmpty').addEventListener('click', () => {
    closeAddRequestsMenu();
    openModal('importModal');
  });
  document.getElementById('menuConnectFormEmpty').addEventListener('click', () => {
    closeAddRequestsMenu();
    connectToForm();
  });
  // Close any open menu on outside click or Escape.
  document.addEventListener('click', e => {
    const inside = ADD_MENUS.some(m => {
      const wrap = document.getElementById(m.wrap);
      return wrap && wrap.contains(e.target);
    });
    if (!inside) closeAddRequestsMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeAddRequestsMenu();
  });
}


// ============ ADD REQUESTS MENU ============
// Two instances: the top-bar menu and the one inside the empty state.
const ADD_MENUS = [
  { wrap: 'addRequestsWrap', btn: 'addRequestsBtn', menu: 'addRequestsMenu' },
  { wrap: 'addRequestsWrapEmpty', btn: 'addRequestsBtnEmpty', menu: 'addRequestsMenuEmpty' }
];


function toggleAddRequestsMenu(e) { toggleMenu('addRequestsMenu', 'addRequestsBtn', e); }
function toggleAddRequestsMenuEmpty(e) { toggleMenu('addRequestsMenuEmpty', 'addRequestsBtnEmpty', e); }


function toggleMenu(menuId, btnId, e) {
  if (e) e.stopPropagation();
  const willOpen = document.getElementById(menuId).hidden;
  closeAddRequestsMenu();
  if (willOpen) {
    document.getElementById(menuId).hidden = false;
    document.getElementById(btnId).setAttribute('aria-expanded', 'true');
  }
}


// Close every Add Requests menu (top bar and empty state).
function closeAddRequestsMenu() {
  ADD_MENUS.forEach(m => {
    const menu = document.getElementById(m.menu);
    if (menu && !menu.hidden) menu.hidden = true;
    const btn = document.getElementById(m.btn);
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}


// Clear unscheduled requests only; scheduled/booked jobs are kept. Asks first.
function clearRequests() {
  const unscheduled = appState.requests.filter(r => r.scheduled !== true);
  if (unscheduled.length === 0) {
    alert('There are no unscheduled requests to clear.');
    return;
  }
  const keptScheduled = appState.requests.length - unscheduled.length;
  const msg = keptScheduled > 0
    ? `Clear ${unscheduled.length} unscheduled request${unscheduled.length > 1 ? 's' : ''}? ${keptScheduled} scheduled job${keptScheduled > 1 ? 's' : ''} will be kept. This cannot be undone.`
    : `Clear ${unscheduled.length} unscheduled request${unscheduled.length > 1 ? 's' : ''}? This cannot be undone.`;
  if (!confirm(msg)) return;

  appState.requests = appState.requests.filter(r => r.scheduled === true);
  saveData();
  if (currentDetailId !== null) {
    currentDetailId = null;
    document.getElementById('detail').classList.add('hidden');
    document.getElementById('overview').classList.remove('hidden');
  }
  updateUI();
}


// Placeholder until a form-connection approach is wired up in a later step.
function connectToForm() {
  alert('Connect to form response is coming soon. For now, export your form responses to CSV and use Import CSV.');
}


// ============ SETTINGS MANAGEMENT ============
// Reads from the cached row loaded on sign-in (see window.App.onSignedIn, which
// populates it via ensureUserRow); no network round trip on its own.
async function loadSettings() {
  if (_userRow && _userRow.settings && Object.keys(_userRow.settings).length) {
    appState.settings = { ...appState.settings, ...(_userRow.settings) };
  }
  // Coerce numeric settings so hand-edited or partially-shaped saved values behave.
  appState.settings.businessStartHour = numOr(appState.settings.businessStartHour, 8);
  appState.settings.businessEndHour = numOr(appState.settings.businessEndHour, 17);
  appState.settings.dailyCapHours = numOr(appState.settings.dailyCapHours, 8.5);
  appState.settings.lunchEnabled = !!appState.settings.lunchEnabled;
  // Scheduling target windows (working days), user-editable. Clamp to >= 1.
  appState.settings.deadlineHighDays = Math.max(1, Math.round(numOr(appState.settings.deadlineHighDays, 1)));
  appState.settings.deadlineMediumDays = Math.max(1, Math.round(numOr(appState.settings.deadlineMediumDays, 3)));
  appState.settings.deadlineLowDays = Math.max(1, Math.round(numOr(appState.settings.deadlineLowDays, 7)));
  appState.settings.deadlineNonRepairDays = Math.max(1, Math.round(numOr(appState.settings.deadlineNonRepairDays, 14)));
  appState.settings.allowMoveBooked = !!appState.settings.allowMoveBooked;
  if (!SORT_OPTIONS.includes(appState.settings.sortBy)) appState.settings.sortBy = 'date-asc';
  updateBaseLabel();
}


// Parse a value to a finite number, falling back to a default.
function numOr(v, fallback) {
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}


// Read the settings modal, validate the scheduling inputs (business hours, daily cap,
// lunch), then commit business info, hours, the per-priority target windows, and the AI
// provider config to appState and the user's account. Invalid hour/cap combinations are rejected
// with an alert so a bad window can never be saved. Re-renders the UI on success.
function saveSettings() {
  const businessName = document.getElementById('businessName').value;
  const baseAddress = document.getElementById('baseAddress').value;

  // Read and validate the scheduling inputs before committing anything.
  const startHour = timeStrToHour(document.getElementById('businessStart').value);
  const endHour = timeStrToHour(document.getElementById('businessEnd').value);
  const cap = numOr(document.getElementById('dailyCap').value, NaN);
  const lunchEnabled = document.getElementById('lunchEnabled').checked;
  const lunchStart = document.getElementById('lunchStart').value;
  const lunchEnd = document.getElementById('lunchEnd').value;

  if (startHour === null || endHour === null || endHour <= startHour) {
    alert('Business hours are invalid: the end time must be after the start time.');
    return;
  }
  if (!isFinite(cap) || cap <= 0) {
    alert('Daily work cap must be a number greater than 0.');
    return;
  }
  let lunchHours = 0;
  if (lunchEnabled) {
    const ls = timeStrToHour(lunchStart);
    const le = timeStrToHour(lunchEnd);
    if (ls === null || le === null || le <= ls) {
      alert('Lunch break is invalid: the end time must be after the start time.');
      return;
    }
    lunchHours = le - ls;
  }
  // The cap plus a blocked lunch can never exceed the business hours window,
  // since lunch and the cap's work activity both have to fit inside it.
  const operatingHours = endHour - startHour;
  if (cap + lunchHours > operatingHours) {
    if (lunchEnabled) {
      alert(`Daily work cap (${cap}h) plus the lunch break (${lunchHours}h) cannot exceed business hours (${operatingHours}h). Reduce the cap or shorten lunch.`);
    } else {
      alert(`Daily work cap (${cap}h) cannot exceed business hours (${operatingHours}h).`);
    }
    return;
  }

  appState.settings.businessName = businessName || appState.settings.businessName;
  appState.settings.baseAddress = baseAddress || appState.settings.baseAddress;
  appState.settings.businessStartHour = startHour;
  appState.settings.businessEndHour = endHour;
  appState.settings.dailyCapHours = cap;
  appState.settings.lunchEnabled = lunchEnabled;
  appState.settings.lunchStart = lunchStart;
  appState.settings.lunchEnd = lunchEnd;
  appState.settings.aiProvider = document.getElementById('aiProvider').value;
  appState.settings.aiApiKey = document.getElementById('aiApiKey').value.trim();
  appState.settings.aiModel = document.getElementById('aiModel').value.trim();
  appState.settings.aiBaseUrl = document.getElementById('aiBaseUrl').value.trim();
  appState.settings.aiProjectId = document.getElementById('aiProjectId').value.trim();
  appState.settings.deadlineHighDays = Math.max(1, Math.round(numOr(document.getElementById('deadlineHighDays').value, 1)));
  appState.settings.deadlineMediumDays = Math.max(1, Math.round(numOr(document.getElementById('deadlineMediumDays').value, 3)));
  appState.settings.deadlineLowDays = Math.max(1, Math.round(numOr(document.getElementById('deadlineLowDays').value, 7)));
  appState.settings.deadlineNonRepairDays = Math.max(1, Math.round(numOr(document.getElementById('deadlineNonRepairDays').value, 14)));
  appState.settings.allowMoveBooked = document.getElementById('allowMoveBooked').checked;

  // Geocode address (simplified - in production use a real geocoding API)
  if (baseAddress) {
    appState.settings.baseCoordinates = estimateCoordinates(baseAddress);
  }

  persistSettings();
  updateBaseLabel();
  closeModal('settingsModal');

  // Re-render the current screen, and refresh the detail page if one is open so
  // the legacy "next available" insights reflect the new hours.
  updateUI();
  if (currentDetailId !== null && !document.getElementById('detail').classList.contains('hidden')) {
    openDetail(currentDetailId);
  }
}


// Write appState.settings to the user's Supabase row. Fire-and-forget (not awaited by
// callers); the UI proceeds immediately and the write completes in the background.
async function persistSettings() {
  if (!currentUserId) return;
  if (_userRow) _userRow.settings = appState.settings;
  const { error } = await Auth.client.from('user_data')
    .update({ settings: appState.settings }).eq('user_id', currentUserId);
  if (error) console.error('Failed to save settings to your account', error);
}


// Refresh the header "base location" chip and pre-fill every field in the settings modal
// from the current settings, so opening Settings always shows the saved values.
function updateBaseLabel() {
  const label = appState.settings.baseAddress || 'Not set';
  document.getElementById('baseLabel').textContent = label;

  // Pre-fill settings modal
  document.getElementById('businessName').value = appState.settings.businessName;
  document.getElementById('baseAddress').value = appState.settings.baseAddress;
  document.getElementById('businessStart').value = hourToTimeStr(appState.settings.businessStartHour);
  document.getElementById('businessEnd').value = hourToTimeStr(appState.settings.businessEndHour);
  document.getElementById('dailyCap').value = appState.settings.dailyCapHours;
  document.getElementById('lunchEnabled').checked = !!appState.settings.lunchEnabled;
  document.getElementById('lunchStart').value = appState.settings.lunchStart;
  document.getElementById('lunchEnd').value = appState.settings.lunchEnd;
  document.getElementById('deadlineHighDays').value = appState.settings.deadlineHighDays;
  document.getElementById('deadlineMediumDays').value = appState.settings.deadlineMediumDays;
  document.getElementById('deadlineLowDays').value = appState.settings.deadlineLowDays;
  document.getElementById('deadlineNonRepairDays').value = appState.settings.deadlineNonRepairDays;
  document.getElementById('allowMoveBooked').checked = !!appState.settings.allowMoveBooked;
  document.getElementById('aiProvider').value = appState.settings.aiProvider || '';
  document.getElementById('aiApiKey').value = appState.settings.aiApiKey || '';
  document.getElementById('aiModel').value = appState.settings.aiModel || '';
  document.getElementById('aiBaseUrl').value = appState.settings.aiBaseUrl || '';
  document.getElementById('aiProjectId').value = appState.settings.aiProjectId || '';
  updateAiProviderHints();
}


// Update the model placeholder, base-URL / project-id visibility, and the web-search
// note, based on the chosen provider.
function updateAiProviderHints() {
  const provider = document.getElementById('aiProvider').value;
  const def = provider ? AIProvider.get(provider) : null;
  const modelEl = document.getElementById('aiModel');
  modelEl.placeholder = def && def.defaultModel ? def.defaultModel : 'Model name';
  const baseRow = document.getElementById('aiBaseUrlRow');
  baseRow.classList.toggle('hidden', !(def && def.needsBaseUrl));
  const projectRow = document.getElementById('aiProjectIdRow');
  if (projectRow) projectRow.classList.toggle('hidden', !(def && def.needsProjectId));
  const note = document.getElementById('aiProviderNote');
  note.textContent = (def && def.webSearch) ? 'Can search the web for live prices and real store links.' : '';
}


// Convert an hour number (8, 17, 8.5) into an "HH:MM" string for time inputs.
function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  const min = Math.round((hour - h) * 60);
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}


// Convert an "HH:MM" string into a fractional hour number (8.5 for "08:30").
function timeStrToHour(str) {
  const parts = String(str || '').split(':');
  const h = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  if (!isFinite(h)) return null;
  return h + (isFinite(min) ? min : 0) / 60;
}


// ============ DATA MANAGEMENT ============
// Reads from the cached row loaded on sign-in (see window.App.onSignedIn, which
// populates it via ensureUserRow); no network round trip on its own.
async function loadData() {
  if (Array.isArray(_userRow && _userRow.requests)) {
    appState.requests = _userRow.requests;
    // Backfill any missing scheduling fields so every job carries the full shape.
    appState.requests.forEach(req => {
      if (typeof req.scheduled !== 'boolean') req.scheduled = false;
      if (req.scheduledStart === undefined) req.scheduledStart = null;
      if (req.scheduledEnd === undefined) req.scheduledEnd = null;
      if (req.requestedDate === undefined) req.requestedDate = null;
      if (typeof req.rescheduleRequested !== 'boolean') req.rescheduleRequested = false;
      if (req.beyondTarget === undefined) req.beyondTarget = null;
    });
  }
}


// Persist all service requests (the imported + classified + scheduled jobs) so the
// board survives a page reload. Called after every mutation to the requests list.
// Fire-and-forget (not awaited by callers); the write completes in the background.
async function saveData() {
  if (!currentUserId) return;
  if (_userRow) _userRow.requests = appState.requests;
  const { error } = await Auth.client.from('user_data')
    .update({ requests: appState.requests }).eq('user_id', currentUserId);
  if (error) console.error('Failed to save requests to your account', error);
}


// ============ PURCHASE LIST PERSISTENCE ============
// Reads from the cached row loaded on sign-in (see window.App.onSignedIn, which
// populates it via ensureUserRow); no network round trip on its own.
async function loadPurchase() {
  const p = _userRow && _userRow.purchase;
  if (!p || typeof p !== 'object' || Object.keys(p).length === 0) return;
  try {
    const prefs = (p && p.prefs) || {};
    appState.purchase = {
      qty: (p && p.qty) || {},
      inStock: (p && p.inStock) || {},
      units: (p && p.units) || {},
      from: (p && p.from) || null,
      to: (p && p.to) || null,
      prefs: {
        maxStores: numOr(prefs.maxStores, 2),
        delivery: ['any', 'pickup', 'delivery', 'in-store'].includes(prefs.delivery) ? prefs.delivery : 'any',
        location: prefs.location || '',
        storeSort: ['cheapest', 'closest'].includes(prefs.storeSort) ? prefs.storeSort : 'cheapest'
      },
      recommendation: (p && p.recommendation) || null
    };
  } catch (_) { /* keep defaults on bad JSON */ }
}


// Persist the purchase-list state (quantities, in-stock flags, date range, prefs and
// the last AI recommendation) so it is restored on the next visit. Fire-and-forget
// (not awaited by callers); the write completes in the background.
async function savePurchase() {
  if (!currentUserId) return;
  if (_userRow) _userRow.purchase = appState.purchase;
  const { error } = await Auth.client.from('user_data')
    .update({ purchase: appState.purchase }).eq('user_id', currentUserId);
  if (error) console.error('Failed to save purchase list to your account', error);
}


// ============ CSV IMPORT ============
let pendingCSVData = null;


// Read the chosen CSV file in the browser (FileReader, no upload), parse it into
// pending request objects, and show a "Found N requests" preview before the user
// commits the import. Parsing errors are surfaced to the user rather than thrown away.
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const csv = e.target.result;
      pendingCSVData = parseCSV(csv);

      // Show preview
      document.getElementById('importPreview').classList.remove('hidden');
      document.getElementById('previewContent').textContent =
        `Found ${pendingCSVData.length} requests. Ready to import.`;
      document.getElementById('confirmImport').disabled = false;
    } catch (error) {
      alert('Error parsing CSV: ' + error.message);
    }
  };
  reader.readAsText(file);
}


// Turn raw CSV text into fully-classified request objects. Column order is flexible
// (columns are located by header keyword), each data row is run through the offline
// InferenceEngine to infer jobType / urgency / materials / etc., and an id + estimated
// map coordinates are attached. Returns an array of request objects ready to import.
function parseCSV(csv) {
  const lines = csv.split('\n').filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV file is empty or invalid');

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const requests = [];

  // Find column indices (flexible column names)
  const nameIdx = headers.findIndex(h => h.includes('name'));
  const phoneIdx = headers.findIndex(h => h.includes('phone'));
  const emailIdx = headers.findIndex(h => h.includes('email'));
  const addressIdx = headers.findIndex(h => h.includes('address'));
  const dateIdx = headers.findIndex(h => h.includes('date'));
  const messageIdx = headers.findIndex(h => h.includes('description') || h.includes('problem') || h.includes('message'));

  if (messageIdx === -1) {
    throw new Error('Could not find problem description column');
  }

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < headers.length) continue;

    const request = {
      id: makeRequestId(),
      name: nameIdx >= 0 ? values[nameIdx]?.trim() : '',
      phone: phoneIdx >= 0 ? values[phoneIdx]?.trim() : '',
      email: emailIdx >= 0 ? values[emailIdx]?.trim() : '',
      address: addressIdx >= 0 ? values[addressIdx]?.trim() : '',
      message: messageIdx >= 0 ? values[messageIdx]?.trim() : '',
      requestedDate: dateIdx >= 0 ? parseRequestedDate(values[dateIdx]) : null,
      scheduled: false,
      scheduledStart: null,
      scheduledEnd: null
    };

    // Run inference engine
    const analysis = InferenceEngine.analyze(request);
    request.jobType = analysis.jobType;
    request.partOfHouse = analysis.partOfHouse;
    request.urgency = analysis.urgency;
    request.laborMin = analysis.laborEstimate.min;
    request.laborMax = analysis.laborEstimate.max;
    request.materials = analysis.materials;
    request.tools = analysis.tools;
    request.uncertainties = analysis.uncertainties;
    request.point = estimateCoordinates(request.address);

    requests.push(request);
  }

  return requests;
}


// Split a single CSV line into fields, respecting double-quoted values so that commas
// inside a quoted field (for example a full "street, city, state" address) do not split
// the row. A minimal parser, sufficient for the well-formed export files this app reads.
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);

  return values.map(v => v.replace(/^"|"$/g, '').trim());
}


// Parse a "Date Requested" cell into an ISO string, or null when missing/unparseable.
// Accepts "YYYY-MM-DD HH:MM", "YYYY-MM-DD", and other Date-parseable forms; a missing
// or invalid value becomes null (treated as unknown) so it never blocks an import.
function parseRequestedDate(raw) {
  const str = (raw || '').trim();
  if (!str) return null;
  // Normalize "YYYY-MM-DD HH:MM" to ISO-ish "YYYY-MM-DDTHH:MM" so it parses as local time.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') : str;
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}


// Identity key for duplicate detection: same customer name, phone, and message.
function dedupeKey(job) {
  return [job.name || '', job.phone || '', job.message || '']
    .map(s => s.trim().toLowerCase())
    .join('||');
}


function confirmImport() {
  if (!pendingCSVData) return;

  // Append to existing requests, skipping rows that exactly match one already present
  // (same name + phone + message) so re-importing the same file does not double up.
  const existingKeys = new Set(appState.requests.map(dedupeKey));
  const newJobs = pendingCSVData.filter(job => {
    const key = dedupeKey(job);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });
  appState.requests = appState.requests.concat(newJobs);
  saveData();
  updateUI();
  closeModal('importModal');
  enrichJobsWithAI(newJobs);

  const skipped = pendingCSVData.length - newJobs.length;
  if (skipped > 0) {
    alert(`Imported ${newJobs.length} request${newJobs.length === 1 ? '' : 's'}. Skipped ${skipped} duplicate${skipped === 1 ? '' : 's'} already in the list.`);
  }

  // Reset import state
  pendingCSVData = null;
  document.getElementById('csvFile').value = '';
  document.getElementById('importPreview').classList.add('hidden');
  document.getElementById('confirmImport').disabled = true;
}


// ============ AI ENRICHMENT (optional; when configured, used for 100% of jobs) ============
// Transient, in-session only: never persisted, since they're just UI feedback about
// in-flight or failed AI calls, not data about the job itself.
const aiPendingIds = new Set();
const aiErrorMessages = new Map();


// When an AI provider is configured, the API is used for 100% of jobs, so any job
// that actually has a message to read is eligible. The "no description provided" case
// has nothing for the AI to read, so it is never sent.
function isAiEligible(r) {
  return !!(r.message && r.message.trim());
}


// Even a clear message leaves things to confirm, and the AI sometimes returns empty
// uncertainties. Guarantee a useful, non-empty list: deterministic contact-info gaps
// first, then the AI's items, then sensible defaults, so the checklist always exists
// (a short client message rarely pins down the exact fault, even for an expert).
function guaranteeUncertainties(unc, job) {
  const missing = v => !(v && String(v).trim());
  const phoneCall = [];
  if (missing(job.name)) phoneCall.push('Customer name not provided: collect on the booking call');
  if (missing(job.phone)) phoneCall.push('Customer phone not provided: needed to confirm details');
  if (missing(job.email)) phoneCall.push('Customer email not provided');
  if (missing(job.address)) phoneCall.push('Customer address not provided: needed for scheduling and distance');

  const aiPhone = (unc && Array.isArray(unc.phoneCall)) ? unc.phoneCall : [];
  const aiSite = (unc && Array.isArray(unc.onSite)) ? unc.onSite : [];
  aiPhone.forEach(q => { if (q && String(q).trim() && !phoneCall.includes(q)) phoneCall.push(String(q)); });
  const onSite = aiSite.filter(q => q && String(q).trim()).map(String);

  if (phoneCall.length === 0) {
    phoneCall.push('Confirm the exact symptom, when it happens, and what the customer has already tried');
    phoneCall.push('Confirm the appointment time and address');
  }
  if (onSite.length === 0) {
    onSite.push('Confirm the scope and conditions on-site before starting work');
    onSite.push('Diagnose the root cause and verify the fix before quoting');
  }
  return { phoneCall, onSite };
}


// Drop "A or B?" style questions the customer's message already answers, so the checklist
// only shows what genuinely still needs confirming (e.g. do not ask "electric or gas?" when
// the message says "electric water heater"). Conservative by design: a question is removed
// only when it offers a TYPED choice (a number/hyphenated form, or a known type word) and
// the message contains that option as a whole word, so ordinary questions are never dropped.
const CHOICE_WORDS = new Set(['electric', 'gas', 'wired', 'battery', 'smart', 'hardwired',
  'wireless', 'copper', 'aluminum', 'led', 'incandescent', 'indoor', 'outdoor', 'single',
  'double', 'manual', 'automatic', 'digital', 'plug', 'portable', 'standby']);
function pruneAnsweredUncertainties(list, message) {
  if (!Array.isArray(list) || list.length === 0) return Array.isArray(list) ? list : [];
  const msg = ' ' + String(message || '').toLowerCase().replace(/[^a-z0-9\- ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  if (msg.trim().length < 3) return list;
  const hasWord = w => w.length >= 3 && msg.indexOf(' ' + w + ' ') !== -1;
  const typed = w => /[0-9\-]/.test(w) || CHOICE_WORDS.has(w);
  return list.filter(q => {
    const ql = String(q).toLowerCase();
    let i = ql.indexOf(' or ');
    while (i !== -1) {
      const before = ql.slice(0, i).match(/([a-z0-9\-]+)\s*$/);
      const after = ql.slice(i + 4).match(/^\s*([a-z0-9\-]+)/);
      const opts = [];
      if (before) opts.push(before[1]);
      if (after) opts.push(after[1]);
      if (opts.some(o => typed(o) && hasWord(o))) return false; // message already answers it
      i = ql.indexOf(' or ', i + 4);
    }
    return true;
  });
}


// Run AI classification for one job: shows a pending badge while in flight, merges
// the result into the job on success, records an error message on failure. Safe to
// call with no API key configured (AIEnrichment.classify fails fast in that case).
async function runAIClassification(job) {
  aiPendingIds.add(job.id);
  aiErrorMessages.delete(job.id);
  refreshAfterAIChange(job.id);

  try {
    const result = await AIEnrichment.classify(
      job.message,
      { name: job.name, address: job.address },
      aiConfig()
    );
    job.jobType = result.jobType;
    job.partOfHouse = result.partOfHouse;
    job.urgency = result.urgency;
    job.inScope = result.inScope;
    if (result.inScope === false) {
      // New installation / project: keep it out of repair scope, mirroring the offline
      // engine. Materials, tools, and labor are not estimated for out-of-scope jobs, so
      // the detail page stays consistent with its "outside repair scope" note.
      job.laborMin = 0;
      job.laborMax = 0;
      job.materials = [];
      job.tools = [];
    } else {
      job.laborMin = result.laborEstimate.min;
      job.laborMax = result.laborEstimate.max;
      job.materials = result.materials;
      job.tools = result.tools;
    }
    job.uncertainties = guaranteeUncertainties(result.uncertainties, job);
    saveData();
  } catch (err) {
    aiErrorMessages.set(job.id, err.message || 'AI classification failed.');
    console.warn('AI classification failed for job', job.id, err);
  } finally {
    aiPendingIds.delete(job.id);
    refreshAfterAIChange(job.id);
  }
}


// Re-render whatever is currently visible so AI pending/result state shows up live,
// whether that's the board (card badge) or an open detail page for this job.
function refreshAfterAIChange(jobId) {
  updateUI();
  if (currentDetailId === jobId && !document.getElementById('detail').classList.contains('hidden')) {
    openDetail(jobId);
  }
}


// Kick off background AI classification after an import. When an API is configured the
// AI is used for 100% of jobs (it re-reads every request, overriding the offline
// engine's result, which stays as the instant base and the fallback if a call fails).
// No-op when no API key is configured, so offline-only behavior is unchanged. Runs one
// job at a time to stay polite to provider rate limits.
async function enrichJobsWithAI(jobs) {
  if (!aiConfigured()) return;
  const eligible = jobs.filter(isAiEligible);
  for (const job of eligible) {
    await runAIClassification(job);
  }
}


// Manual retry, wired to the "Try AI classification" button on a job's detail page.
function retryAIClassification(id) {
  const job = findJob(id);
  if (!job) return;
  if (!aiConfigured()) {
    alert('Add an AI provider and API key in Settings to enable AI classification.');
    return;
  }
  runAIClassification(job);
}


// ============ DATA EXPORT ============
function exportData() {
  if (appState.currentScreen === 'scheduled') {
    exportScheduleAsICS();
    return;
  }

  if (appState.requests.length === 0) {
    alert('No data to export');
    return;
  }

  // Create CSV
  const headers = ['Customer Name', 'Phone', 'Email', 'Address', 'Problem Description',
                   'Job Type', 'Part of House', 'Urgency', 'Labor Min', 'Labor Max'];
  const rows = appState.requests.map(r => [
    r.name, r.phone, r.email, r.address, r.message,
    r.jobType, r.partOfHouse, r.urgency, r.laborMin, r.laborMax
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `electrician-requests-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


// Export every scheduled job as an .ics calendar file (RFC 5545), importable into
// Google Calendar, Apple Calendar, Outlook, and other calendar apps.
function exportScheduleAsICS() {
  const scheduledJobs = appState.requests.filter(r => r.scheduled === true && r.scheduledStart && r.scheduledEnd);
  if (scheduledJobs.length === 0) {
    alert('No scheduled services to export');
    return;
  }

  const stamp = toICSDateTime(new Date().toISOString());
  const events = scheduledJobs.map(r => buildICSEvent(r, stamp)).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Electrician Job Dispatch//Scheduling//EN',
    'CALSCALE:GREGORIAN',
    events,
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scheduled-services-${new Date().toISOString().split('T')[0]}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}


// Build a single VEVENT block for one scheduled job.
function buildICSEvent(r, stamp) {
  const descLines = [
    `Job type: ${r.jobType || 'Not determined'}`,
    `Urgency: ${r.urgency || 'unknown'}`,
    r.phone ? `Phone: ${r.phone}` : null,
    r.email ? `Email: ${r.email}` : null,
    r.message ? `Customer message: ${r.message}` : null
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VEVENT',
    `UID:job-${r.id}@electrician-job-dispatch`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toICSDateTime(r.scheduledStart)}`,
    `DTEND:${toICSDateTime(r.scheduledEnd)}`,
    `SUMMARY:${escapeICSText(r.jobType || 'Service call')} for ${escapeICSText(r.name || 'customer')}`,
    r.address ? `LOCATION:${escapeICSText(r.address)}` : null,
    `DESCRIPTION:${escapeICSText(descLines)}`,
    'END:VEVENT'
  ].filter(Boolean).join('\r\n');
}


// Convert an ISO timestamp (already UTC) into the YYYYMMDDTHHMMSSZ form ICS requires.
function toICSDateTime(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}


// Escape text per RFC 5545 (backslash, semicolon, comma, newline).
function escapeICSText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}


// ============ UI RENDERING ============
// The jobs shown on the active screen: unscheduled on Overview, scheduled on Scheduled.
function currentList() {
  return appState.requests.filter(r =>
    appState.currentScreen === 'scheduled' ? r.scheduled === true : r.scheduled !== true
  );
}


// The single entry point for re-rendering. Shows the correct screen (overview /
// scheduled / purchase / detail), refreshes the metric cards and the job board, and
// keeps the nav tabs + export button label in sync. Called after any state change.
function updateUI() {
  const emptyState = document.getElementById('emptyState');
  const emptyStateAlt = document.getElementById('emptyStateAlt');
  const dataView = document.getElementById('dataView');

  applyScreenChrome();

  if (appState.currentScreen === 'purchase') {
    document.getElementById('overview').classList.add('hidden');
    document.getElementById('purchase').classList.remove('hidden');
    renderPurchase();
    return;
  }
  document.getElementById('purchase').classList.add('hidden');

  if (appState.requests.length === 0) {
    // No imported jobs at all: show the original import-prompt empty state.
    emptyState.classList.remove('hidden');
    emptyStateAlt.classList.add('hidden');
    dataView.classList.add('hidden');
    return;
  }

  const list = currentList();
  if (list.length === 0) {
    // Jobs exist, but none on this screen: show the screen-specific empty state.
    emptyState.classList.add('hidden');
    dataView.classList.add('hidden');
    setAltEmptyState();
    emptyStateAlt.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  emptyStateAlt.classList.add('hidden');
  dataView.classList.remove('hidden');
  renderSummary(list);
  renderRows(list);
}


// Update the eyebrow, title, lede, top-bar buttons, and active nav item per screen.
function applyScreenChrome() {
  const screen = appState.currentScreen;
  const isReq = screen === 'overview';
  const isSched = screen === 'scheduled';
  const isPur = screen === 'purchase';

  const eyebrow = isPur ? 'Purchase list' : isSched ? 'Scheduled services' : 'Service requests overview';
  const title = isPur ? 'Purchase list' : isSched ? 'Scheduled services' : 'Incoming service requests';
  const lede = isPur
    ? 'Materials needed for scheduled jobs in the selected dates. Check off what you already have.'
    : isSched
      ? 'Booked jobs with a confirmed window. Select any card to open the full job summary.'
      : 'Sorted by urgency. Select any card to open the full job summary.';
  document.getElementById('ovEyebrow').textContent = eyebrow;
  document.getElementById('ovTitle').textContent = title;
  document.getElementById('ovLede').textContent = lede;

  document.getElementById('navRequests').classList.toggle('active', isReq);
  document.getElementById('navScheduled').classList.toggle('active', isSched);
  document.getElementById('navPurchase').classList.toggle('active', isPur);

  // Add Requests only on the Requests screen; Export on Requests/Scheduled (not Purchase).
  if (!isReq) closeAddRequestsMenu();
  document.getElementById('addRequestsWrap').classList.toggle('hidden', !isReq);
  document.getElementById('exportBtn').classList.toggle('hidden', isPur);
  if (!isPur) {
    document.getElementById('exportBtnLabel').textContent =
      isSched ? 'Export as Calendar Events' : 'Export Requests CSV';
  }
}


// Fill the screen-specific empty state text for the active screen.
function setAltEmptyState() {
  const scheduled = appState.currentScreen === 'scheduled';
  document.getElementById('emptyStateAltHeading').textContent =
    scheduled ? 'No scheduled services yet' : 'No incoming requests';
  document.getElementById('emptyStateAltText').textContent =
    scheduled
      ? 'Open a request from the overview and schedule it to see it here.'
      : 'Every request has been scheduled. Switch to scheduled services to view them.';
}


// Render the four metric cards at the top of the board: total plus a count per urgency
// (high / medium / low), colour-coded to match the urgency palette.
function renderSummary(list) {
  const counts = { high: 0, medium: 0, low: 0 };
  list.forEach(r => counts[r.urgency]++);

  document.getElementById('summary').innerHTML = `
    <div class="metric"><div class="n">${list.length}</div><div class="l">Total requests</div></div>
    <div class="metric high"><div class="n">${counts.high}</div><div class="l">High urgency</div></div>
    <div class="metric med"><div class="n">${counts.medium}</div><div class="l">Medium urgency</div></div>
    <div class="metric low"><div class="n">${counts.low}</div><div class="l">Low urgency</div></div>
  `;
}


const URG_CLASS = { high: 'high', medium: 'med', low: 'low' };


// Valid "sort by" values for the Requests board: "<field>-<direction>".
const SORT_OPTIONS = ['date-asc', 'date-desc', 'distance-asc', 'distance-desc', 'labor-asc', 'labor-desc'];


// The sortable numeric value for a job under a given field, or null when missing.
// Missing values are treated as the lowest value (see sortComparator), so they follow
// the sort direction: bottom when descending, top when ascending.
function sortValue(job, field) {
  if (field === 'date') {
    if (!job.requestedDate) return null;
    const t = new Date(job.requestedDate).getTime();
    return isNaN(t) ? null : t;
  }
  if (field === 'distance') {
    // With no base set, every card is equidistant (stable order). With a base but no
    // geocoded point, the distance is unknown (missing).
    if (!appState.settings.baseCoordinates) return 0;
    if (!job.point) return null;
    return straightLineMiles(appState.settings.baseCoordinates, job.point) * 1.3;
  }
  if (field === 'labor') {
    return ((job.laborMin || 0) + (job.laborMax || 0)) / 2;
  }
  return null;
}


// Build a comparator from a "<field>-<direction>" sort key. Missing values sort as the
// lowest value, so ascending puts them first and descending puts them last.
function sortComparator(sortBy) {
  const [field, dir] = String(sortBy || 'date-asc').split('-');
  return (a, b) => {
    let va = sortValue(a, field);
    let vb = sortValue(b, field);
    if (va === null) va = -Infinity;
    if (vb === null) vb = -Infinity;
    return dir === 'desc' ? vb - va : va - vb;
  };
}


// Small inline icons reused inside job cards.
const ICO_PERSON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="2"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICO_PHONE = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1 1 0 0 1-1 1A15 15 0 0 1 4 5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const ICO_EMAIL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1" stroke="currentColor" stroke-width="2"/><path d="M4 6l8 7 8-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICO_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';


// Build one clickable job card. Shows the booked window prominently when showWindow is set
// (the Scheduled screen); the urgency-colored left border is always shown.
function buildJobCard(r, showWindow) {
  const card = document.createElement('div');
  card.className = 'job-card ' + URG_CLASS[r.urgency] + (r.rescheduleRequested ? ' reschedule' : '');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open job summary for ${r.jobType}`);

  const laborText = r.inScope === false ? 'N/A' : `~${r.laborMin}-${r.laborMax} hrs`;
  const windowHTML = showWindow
    ? `<div class="job-card-window">${esc(formatWindowTimeRange(r.scheduledStart, r.scheduledEnd))}</div>`
    : '';
  const aiBadgeHTML = aiPendingIds.has(r.id) ? `<div class="ai-badge">Checking with AI...</div>` : '';
  const rescheduleBanner = r.rescheduleRequested
    ? `<div class="job-card-reschedule">Customer asked to change the time, contact them to reschedule</div>`
    : '';

  card.innerHTML = `
    ${rescheduleBanner}
    ${windowHTML}
    ${aiBadgeHTML}
    <div class="job-card-title">${esc(r.jobType)}</div>
    <div class="job-card-meta">
      <span>${esc(r.partOfHouse)} &middot; ${esc(laborText)}</span>
      <span class="job-card-date${r.requestedDate ? '' : ' missing-date'}">${r.requestedDate ? esc(formatRequestedDate(r.requestedDate)) : 'No date'}</span>
    </div>
    <div class="job-card-rule"></div>
    <div class="job-card-contacts">
      <div class="job-card-contact">${ICO_PERSON}${r.name ? esc(r.name) : '<span class="missing">Not provided</span>'}</div>
      <div class="job-card-contact">${ICO_PHONE}<span class="mono">${r.phone ? esc(r.phone) : '<span class="missing">Not provided</span>'}</span></div>
      <div class="job-card-contact">${ICO_EMAIL}<span class="mono">${r.email ? esc(r.email) : '<span class="missing">Not provided</span>'}</span></div>
    </div>
    <div class="job-card-footer">
      <button type="button" class="job-card-schedule-btn">${r.scheduled ? 'Reschedule' : 'Schedule'}</button>
      <span class="job-card-open">Open ${ICO_CHEVRON}</span>
    </div>
  `;

  card.querySelector('.job-card-schedule-btn').addEventListener('click', e => {
    e.stopPropagation();
    openScheduleModal(r.id);
  });
  card.addEventListener('click', () => openDetail(r.id));
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail(r.id);
    }
  });

  return card;
}


// Render the job cards for the active board. On the Requests screen cards are grouped by
// urgency (high/medium/low) and honour the sort control; on the Scheduled screen they are
// grouped by day with the booked window shown. Empty states are handled per screen.
function renderRows(list) {
  const board = document.getElementById('board');
  board.innerHTML = '';

  const scheduledScreen = appState.currentScreen === 'scheduled';

  // The sort control only applies to the Requests board, so show it only there.
  document.getElementById('sortBar').classList.toggle('hidden', scheduledScreen);

  if (!scheduledScreen) {
    board.className = 'board board-urgency';
    const compare = sortComparator(appState.settings.sortBy);
    const columns = [
      { key: 'high', label: 'High urgency' },
      { key: 'medium', label: 'Medium urgency' },
      { key: 'low', label: 'Low urgency' }
    ];
    columns.forEach(col => {
      // Each urgency column is sorted independently by the chosen criteria.
      const colJobs = list.filter(r => r.urgency === col.key).sort(compare);
      const colEl = document.createElement('div');
      colEl.className = 'board-col';
      const head = document.createElement('div');
      head.className = 'board-col-head ' + URG_CLASS[col.key];
      head.innerHTML = `<span class="board-col-title">${col.label}</span><span class="board-col-count">${colJobs.length}</span>`;
      colEl.appendChild(head);
      if (colJobs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'board-col-empty';
        empty.textContent = 'No requests in this column.';
        colEl.appendChild(empty);
      } else {
        colJobs.forEach(r => colEl.appendChild(buildJobCard(r, false)));
      }
      board.appendChild(colEl);
    });
    return;
  }

  // Scheduled screen: day sections, days ascending, jobs within a day by start time.
  board.className = 'board board-days';
  const days = new Map();
  list.forEach(r => {
    const key = new Date(r.scheduledStart).toDateString();
    if (!days.has(key)) days.set(key, { date: new Date(r.scheduledStart), jobs: [] });
    days.get(key).jobs.push(r);
  });

  [...days.values()]
    .sort((a, b) => a.date - b.date)
    .forEach(group => {
      group.jobs.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));
      const section = document.createElement('div');
      section.className = 'day-section';
      const head = document.createElement('div');
      head.className = 'day-section-head';
      const headLabel = document.createElement('span');
      headLabel.textContent = formatDayHeader(group.date, group.jobs.length);
      head.appendChild(headLabel);
      const mapUrl = buildDayMapUrl(group.jobs);
      if (mapUrl) {
        const mapLink = document.createElement('a');
        mapLink.className = 'day-map-link';
        mapLink.href = mapUrl;
        mapLink.target = '_blank';
        mapLink.rel = 'noopener noreferrer';
        mapLink.textContent = 'See map';
        head.appendChild(mapLink);
      }
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'day-section-cards';
      group.jobs.forEach(r => cardsWrap.appendChild(buildJobCard(r, true)));
      section.appendChild(head);
      section.appendChild(cardsWrap);
      board.appendChild(section);
    });
}


// ============ PURCHASE LIST ============
// Normalize a material name so the same item aggregates regardless of case/spacing.
function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}


// Keyword rules to assign a purchasing unit to inference-engine materials (which carry
// no unit of their own). First matching keyword wins; otherwise the default is "each".
// Order matters: more specific items (connectors, fuses) are checked before generic
// "wire"/"cable" so e.g. "Wire connectors" resolves to a pack, not feet of wire.
const UNIT_RULES = [
  { kw: ['connector', 'wire nut', 'pigtail'], unit: 'pack' },
  { kw: ['fuse'], unit: 'pack' },
  { kw: ['compound'], unit: 'tube' },
  { kw: ['kit'], unit: 'kit' },
  { kw: ['conduit', 'cable', 'led strip', 'strip'], unit: 'ft' }
];


// The intrinsic unit for a material: an explicit unit (manual or API search) wins,
// otherwise resolve from the name, falling back to "each".
function materialUnit(material) {
  if (material && material.unit && String(material.unit).trim()) return String(material.unit).trim();
  return resolveUnit(material ? material.name : '');
}


// Guess the purchasing unit for a material name (pack / ft / tube / kit / each) from
// keyword rules, so the purchase list shows a sensible unit the user can still override.
function resolveUnit(name) {
  const n = normName(name);
  if (!n) return 'each';
  for (const rule of UNIT_RULES) {
    if (rule.kw.some(k => n.includes(k))) return rule.unit;
  }
  // Bare "wire" (e.g. "Replacement cable / wire") sells by the foot, but "wiring" does not.
  if (/\bwire\b/.test(n)) return 'ft';
  return 'each';
}


// Format a Date as YYYY-MM-DD for a date input.
function toDateInputValue(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


// Default purchase window: today through the 5th upcoming work day (weekends skipped).
function defaultPurchaseRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const cursor = new Date(start);
  let workDays = 0;
  while (workDays < 5) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) workDays++;
    if (workDays < 5) cursor.setDate(cursor.getDate() + 1);
  }
  return { from: toDateInputValue(start), to: toDateInputValue(cursor) };
}


// Aggregate materials from scheduled jobs whose start date falls in [fromStr, toStr],
// deduped by normalized name, keeping the highest confidence seen.
function aggregatePurchaseMaterials(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00');
  const to = new Date(toStr + 'T23:59:59');
  const PROB_RANK = { maybe: 0, likely: 1, surely: 2 };
  const map = new Map();
  appState.requests.forEach(job => {
    if (job.scheduled !== true || !job.scheduledStart) return;
    const start = new Date(job.scheduledStart);
    if (isNaN(start.getTime()) || start < from || start > to) return;
    const mats = Array.isArray(job.materials) ? job.materials : [];
    mats.forEach(m => {
      if (!m || !m.name) return;
      const key = normName(m.name);
      if (!key) return;
      // Permits are a paperwork line item, not something bought from a store.
      if (/\bpermit/.test(key)) return;
      const hasExplicitUnit = !!(m.unit && String(m.unit).trim());
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { key, name: String(m.name).trim(), prob: m.prob || 'surely', unit: materialUnit(m), explicitUnit: hasExplicitUnit, jobs: new Set([job.id]) });
      } else {
        existing.jobs.add(job.id);
        if ((PROB_RANK[m.prob] || 0) > (PROB_RANK[existing.prob] || 0)) existing.prob = m.prob;
        // An explicitly-set unit (manual/API) beats a name-resolved default.
        if (hasExplicitUnit && !existing.explicitUnit) {
          existing.unit = String(m.unit).trim();
          existing.explicitUnit = true;
        }
      }
    });
  });
  return [...map.values()]
    .map(e => ({ key: e.key, name: e.name, prob: e.prob, unit: e.unit, jobCount: e.jobs.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}


// Mark a material as already in stock (or not). In-stock items move to a separate group
// and are excluded from the "to buy" list and the AI recommendation.
function togglePurchaseStock(key, checked) {
  if (checked) appState.purchase.inStock[key] = true;
  else delete appState.purchase.inStock[key];
  savePurchase();
  renderPurchase();
}


// Save a per-material quantity override (minimum 1). Keyed by normalized material name.
function setPurchaseQty(key, value) {
  let n = parseInt(value, 10);
  if (!isFinite(n) || n < 1) n = 1;
  appState.purchase.qty[key] = n;
  savePurchase();
}


// Override a material's unit. Blank clears the override so it reverts to the default.
function setPurchaseUnit(key, value) {
  const v = String(value || '').trim();
  if (v) appState.purchase.units[key] = v;
  else delete appState.purchase.units[key];
  savePurchase();
}


// Transient state for the recommendations request (not persisted).
let aiRecPending = false;
let aiRecError = '';


// Update one purchase preference (max stores / purchase method / location / store sort)
// and persist it. These feed the AI recommendation prompt and the client-side re-sort.
function setPurchasePref(key, value) {
  if (key === 'maxStores') {
    let n = parseInt(value, 10);
    appState.purchase.prefs.maxStores = (isFinite(n) && n >= 1) ? n : 1;
  } else if (key === 'delivery') {
    appState.purchase.prefs.delivery = value;
  } else if (key === 'location') {
    appState.purchase.prefs.location = String(value || '').trim();
  } else if (key === 'storeSort') {
    appState.purchase.prefs.storeSort = ['cheapest', 'closest'].includes(value) ? value : 'cheapest';
  }
  savePurchase();
}


// Parse a "$1,234.56" price into a number (Infinity when unparseable, so it sorts last).
function parseMoney(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : Infinity;
}


// Parse "3.2 mi" / "12 min" into a number for sorting (Infinity when unknown).
function parseDistance(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : Infinity;
}


// Order store carts by the chosen filter without re-calling the AI.
function sortStores(stores, mode) {
  const copy = [...stores];
  if (mode === 'closest') {
    copy.sort((a, b) => parseDistance(a.distance) - parseDistance(b.distance));
  } else {
    copy.sort((a, b) => parseMoney(a.estTotal) - parseMoney(b.estTotal));
  }
  return copy;
}


// The materials still to buy in the current date range, with resolved qty + unit.
function currentToBuyItems() {
  const mats = aggregatePurchaseMaterials(appState.purchase.from, appState.purchase.to)
    .filter(m => !appState.purchase.inStock[m.key]);
  return mats.map(m => ({
    name: m.name,
    qty: appState.purchase.qty[m.key] != null ? appState.purchase.qty[m.key] : 1,
    unit: appState.purchase.units[m.key] != null ? appState.purchase.units[m.key] : m.unit
  }));
}


// Ask the configured AI provider for a best-price / best-store recommendation. Anthropic
// uses live web search; other providers return AI estimates. Result is cached + persisted.
async function generateRecommendations() {
  if (!aiConfigured()) {
    alert('Add an AI provider and API key in Settings to unlock recommendations.');
    return;
  }
  const items = currentToBuyItems();
  if (items.length === 0) {
    alert('Nothing to buy in this date range yet. Add materials or widen the dates.');
    return;
  }

  aiRecPending = true;
  aiRecError = '';
  renderPurchase();

  const webSearch = AIProvider.supportsWebSearch(appState.settings.aiProvider);
  const prefs = appState.purchase.prefs;
  const location = prefs.location || appState.settings.baseAddress || 'not specified';
  const multi = prefs.maxStores > 1;
  const system = `You are a purchasing assistant for a residential electrician in the United States.
${webSearch
    ? 'Use web search to find CURRENT prices at major US retailers (Home Depot, Lowe\'s, Menards, and electrical supply houses). Include the real product page URL you found for each item.'
    : 'You do not have live prices. Give realistic price ESTIMATES and, for each item, a store search URL (for example https://www.homedepot.com/s/<query>).'}
For each store, put in "items" every material that store realistically carries, and list any material it does NOT carry in a "missing" array of material names (use the exact material names given). Prefer stores that carry as many of the materials as possible. Honor the purchase method and use the location to gauge which stores are nearby.
${multi
    ? `The electrician is willing to visit up to ${prefs.maxStores} stores, so return AT LEAST 2 DIFFERENT store options (up to ${prefs.maxStores}) so they can compare.`
    : 'Return a single best store option.'}
Give EACH store a DIFFERENT one-line "insight" describing why it stands out. Vary them widely, for example: "Cheapest overall", "Closest to you", "Best for bulk quantities", "Most reliable stock", "Widest selection", "Fastest pickup", "Best for delivery". Do not label more than one store the same way.
Estimate a "distance" from the location for each store when you can (for example "3.2 mi" or "12 min").
Respond with ONLY a single JSON object, no markdown, with this exact shape:
{
  "stores": [ { "name": "store name", "insight": "short distinct reason this store stands out", "distance": "3.2 mi", "estTotal": "$0.00", "items": [ { "material": "name", "qty": number, "unit": "unit", "estPrice": "$0.00", "url": "https://..." } ], "missing": [ "material name this store does not carry" ] } ],
  "summary": "one or two sentence overview comparing the options"
}
Prices are estimates; never claim they are exact.`;
  const user = JSON.stringify({
    materials: items,
    preferences: { maxStores: prefs.maxStores, purchaseMethod: prefs.delivery, location }
  });

  try {
    const { text, citations } = await AIProvider.complete({ system, user, json: true, webSearch, maxTokens: 3000 }, aiConfig());
    const result = AIProvider.extractJson(text);
    if (!result || !Array.isArray(result.stores)) throw new Error('The AI response did not contain a usable recommendation.');
    appState.purchase.recommendation = {
      result,
      citations: citations || [],
      generatedAt: new Date().toISOString(),
      webSearch,
      provider: appState.settings.aiProvider
    };
    savePurchase();
  } catch (err) {
    aiRecError = err.message || 'Could not generate recommendations.';
    console.warn('Recommendation generation failed', err);
  } finally {
    aiRecPending = false;
    renderPurchase();
  }
}


// Render the whole Purchase List screen: the date-range toolbar, the aggregated
// materials (split into "to buy" and "already in stock"), and the Recommendations &
// insights block. Also (re)wires the date inputs and recommendation controls each render.
function renderPurchase() {
  // Use the saved range, or seed it from the next-5-work-days default the first time.
  if (!appState.purchase.from || !appState.purchase.to) {
    const def = defaultPurchaseRange();
    appState.purchase.from = appState.purchase.from || def.from;
    appState.purchase.to = appState.purchase.to || def.to;
    savePurchase();
  }
  const from = appState.purchase.from;
  const to = appState.purchase.to;

  const mats = aggregatePurchaseMaterials(from, to);
  const toBuy = mats.filter(m => !appState.purchase.inStock[m.key]);
  const inStock = mats.filter(m => appState.purchase.inStock[m.key]);

  const probText = p => p === 'surely' ? 'Surely' : p === 'likely' ? 'Most likely' : 'Maybe';
  const rowHTML = (m, stock) => {
    const qty = appState.purchase.qty[m.key] != null ? appState.purchase.qty[m.key] : 1;
    const unit = appState.purchase.units[m.key] != null ? appState.purchase.units[m.key] : m.unit;
    return `
      <div class="purchase-row${stock ? ' in-stock' : ''}">
        <input type="checkbox" ${stock ? 'checked' : ''} aria-label="Already in stock"
               onchange="togglePurchaseStock('${esc(m.key)}', this.checked)">
        <span class="purchase-name">${esc(m.name)}</span>
        <span class="purchase-count">${m.jobCount} service${m.jobCount === 1 ? '' : 's'}</span>
        <span class="prob ${m.prob}">${probText(m.prob)}</span>
        <span class="purchase-qty"><label>Qty</label>
          <input type="number" min="1" step="1" value="${esc(String(qty))}"
                 onchange="setPurchaseQty('${esc(m.key)}', this.value)">
          <input type="text" class="purchase-unit" value="${esc(unit)}" aria-label="Unit"
                 onchange="setPurchaseUnit('${esc(m.key)}', this.value)">
        </span>
      </div>`;
  };

  const listHTML = mats.length === 0
    ? `<div class="empty-state" style="min-height:auto;padding:48px 20px">
         <div class="empty-state-icon">🧾</div>
         <h3>Nothing to buy yet</h3>
         <p>No materials are needed for scheduled jobs in this date range. Schedule jobs or widen the dates.</p>
       </div>`
    : `<div class="purchase-card">
         ${toBuy.length ? `<div class="purchase-group-head">To buy (${toBuy.length})</div>${toBuy.map(m => rowHTML(m, false)).join('')}` : ''}
         ${inStock.length ? `<div class="purchase-group-head">Already in stock (${inStock.length})</div>${inStock.map(m => rowHTML(m, true)).join('')}` : ''}
       </div>`;

  document.getElementById('purchase').innerHTML = `
    <div class="purchase-toolbar">
      <div class="purchase-field">
        <label for="purchaseFrom">From</label>
        <input type="date" id="purchaseFrom" value="${esc(from)}">
      </div>
      <div class="purchase-field">
        <label for="purchaseTo">To</label>
        <input type="date" id="purchaseTo" value="${esc(to)}">
      </div>
      <div class="purchase-summary">${toBuy.length} to buy &middot; ${inStock.length} in stock</div>
    </div>
    ${listHTML}
    ${buildRecommendationSection(mats.length > 0)}
    <p class="hint">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#6f6f6f" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="#6f6f6f" stroke-width="2" stroke-linecap="round"/></svg>
      Materials come from scheduled jobs in the selected dates. Add materials on a job's detail page.
    </p>
  `;

  const fromEl = document.getElementById('purchaseFrom');
  const toEl = document.getElementById('purchaseTo');
  fromEl.addEventListener('change', () => {
    if (fromEl.value) { appState.purchase.from = fromEl.value; savePurchase(); renderPurchase(); }
  });
  toEl.addEventListener('change', () => {
    if (toEl.value) { appState.purchase.to = toEl.value; savePurchase(); renderPurchase(); }
  });

  // Wire the recommendation controls (present only when configured + there's something to buy).
  const genBtn = document.getElementById('recGenerateBtn');
  if (genBtn) genBtn.addEventListener('click', generateRecommendations);
  const maxEl = document.getElementById('recMaxStores');
  if (maxEl) maxEl.addEventListener('change', () => setPurchasePref('maxStores', maxEl.value));
  const delEl = document.getElementById('recDelivery');
  if (delEl) delEl.addEventListener('change', () => setPurchasePref('delivery', delEl.value));
  const locEl = document.getElementById('recLocation');
  if (locEl) locEl.addEventListener('change', () => setPurchasePref('location', locEl.value));
  const sortEl = document.getElementById('recStoreSort');
  if (sortEl) sortEl.addEventListener('change', () => { setPurchasePref('storeSort', sortEl.value); renderPurchase(); });
}


// The "Recommendations & insights" section. Gated behind an AI key.
function buildRecommendationSection(hasMaterials) {
  if (!aiConfigured()) {
    return `
      <div class="rec-card rec-unavailable">
        <p class="block-label" style="margin-top:0">Recommendations &amp; insights</p>
        <p style="margin:0 0 12px;color:var(--muted);font-size:.9rem">Unavailable. Connect an API key to unlock AI price and store recommendations.</p>
        <button class="btn btn-secondary" onclick="openModal('settingsModal')">Connect API key</button>
      </div>`;
  }

  const prefs = appState.purchase.prefs;
  // Location defaults to the base address from Settings, but stays editable per run.
  const effectiveLocation = prefs.location || appState.settings.baseAddress || '';
  const deliveryOpts = [['any', 'Any'], ['pickup', 'Pickup'], ['delivery', 'Delivery'], ['in-store', 'In-store only']];
  const controls = `
    <div class="rec-prefs">
      <div class="purchase-field">
        <label for="recMaxStores">Maximum Number of Stores</label>
        <input type="number" id="recMaxStores" min="1" step="1" value="${esc(String(prefs.maxStores))}">
      </div>
      <div class="purchase-field">
        <label for="recDelivery">Purchase method</label>
        <select id="recDelivery">
          ${deliveryOpts.map(([v, l]) => `<option value="${v}" ${prefs.delivery === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="purchase-field" style="flex:1 1 180px">
        <label for="recLocation">Location</label>
        <input type="text" id="recLocation" placeholder="ZIP or city" value="${esc(effectiveLocation)}">
      </div>
      <button class="btn btn-primary" id="recGenerateBtn" ${aiRecPending || !hasMaterials ? 'disabled' : ''}>
        ${aiRecPending ? 'Generating...' : 'Generate/Update Recommendations'}
      </button>
    </div>`;

  let body = '';
  if (aiRecPending) {
    body = `<div class="ai-badge">Asking the AI${AIProvider.supportsWebSearch(appState.settings.aiProvider) ? ' and searching the web' : ''}...</div>`;
  } else if (aiRecError) {
    body = `<p class="ai-error">${esc(aiRecError)}</p>`;
  } else if (appState.purchase.recommendation) {
    body = buildRecommendationResult(appState.purchase.recommendation);
  } else if (!hasMaterials) {
    body = `<p style="margin:0;color:var(--muted);font-size:.88rem">Add materials to buy to get a recommendation.</p>`;
  } else {
    body = `<p style="margin:0;color:var(--muted);font-size:.88rem">Set your preferences and generate a price + store recommendation.</p>`;
  }

  const rec = appState.purchase.recommendation;
  const lastGenerated = rec && rec.generatedAt
    ? `<span class="rec-last-generated">Last generated ${esc(formatRequestedDate(rec.generatedAt))}</span>`
    : '';
  return `
    <div class="rec-card">
      <div class="rec-head">
        <p class="block-label" style="margin-top:0">Recommendations &amp; insights</p>
        ${lastGenerated}
      </div>
      ${controls}
      <div class="rec-body">${body}</div>
    </div>`;
}


// Render a cached recommendation result object.
function buildRecommendationResult(rec) {
  const r = rec.result || {};
  const rawStores = Array.isArray(r.stores) ? r.stores : [];
  const best = r.best || '';
  const sortMode = appState.purchase.prefs.storeSort || 'cheapest';
  const stores = sortStores(rawStores, sortMode);

  // Each store shows its own varied insight (falls back to "Best" for the AI's top pick).
  const storeHTML = stores.map(store => {
    const items = Array.isArray(store.items) ? store.items : [];
    const itemsHTML = items.map(it => `
      <div class="rec-item">
        <span class="rec-item-name">${esc(it.material || '')}${it.qty != null ? ` <span class="rec-item-qty">x${esc(String(it.qty))}${it.unit ? ' ' + esc(it.unit) : ''}</span>` : ''}</span>
        <span class="rec-item-price">${esc(it.estPrice || '')}</span>
        ${it.url ? `<a class="rec-item-link" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">view</a>` : ''}
      </div>`).join('');
    const insight = (store.insight && String(store.insight).trim())
      || (best && normName(store.name) === normName(best) ? 'Best' : '');
    const distance = store.distance ? `<span class="rec-store-distance">${esc(store.distance)}</span>` : '';
    // Materials this store does not carry, shown above the store name row.
    const missing = (Array.isArray(store.missing) ? store.missing : [])
      .map(m => String(m || '').trim()).filter(Boolean);
    const missingHTML = missing.length
      ? `<div class="rec-store-missing">Not carried here: ${esc(missing.join(', '))}</div>`
      : '';
    return `
      <div class="rec-store">
        ${missingHTML}
        <div class="rec-store-head">
          <span class="rec-store-name">${esc(store.name || 'Store')}${insight ? ` <span class="rec-insight-badge">${esc(insight)}</span>` : ''}</span>
          <span class="rec-store-meta">${distance}<span class="rec-store-total">${esc(store.estTotal || '')}</span></span>
        </div>
        ${itemsHTML}
      </div>`;
  }).join('');

  const sortControl = stores.length > 1 ? `
    <div class="rec-sort">
      <label for="recStoreSort">Sort store carts by</label>
      <select id="recStoreSort">
        <option value="cheapest" ${sortMode === 'cheapest' ? 'selected' : ''}>Cheapest overall cart</option>
        <option value="closest" ${sortMode === 'closest' ? 'selected' : ''}>Closest distance</option>
      </select>
    </div>` : '';

  const citeHTML = (rec.citations && rec.citations.length)
    ? `<div class="rec-sources"><span class="rec-sources-label">Sources</span>${rec.citations.slice(0, 8).map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a>`).join('')}</div>`
    : '';

  return `
    ${r.summary ? `<p class="rec-summary">${esc(r.summary)}</p>` : ''}
    ${sortControl}
    ${storeHTML || '<p class="missing">No store breakdown returned.</p>'}
    ${citeHTML}
    <p class="rec-disclaimer">${rec.webSearch ? 'AI-retrieved estimates' : 'AI estimates (no live prices)'} &middot; verify prices and availability before buying &middot; generated ${esc(formatRequestedDate(rec.generatedAt))}</p>`;
}


// ============ DETAIL VIEW ============
function openDetail(id) {
  const r = findJob(id);
  if (!r) return;

  // Remember where we came from so Back returns to the right screen.
  currentDetailId = r.id;
  detailOriginScreen = appState.currentScreen;

  const out = (r.inScope === false);
  const _mats = Array.isArray(r.materials) ? r.materials : [];
  const _tools = Array.isArray(r.tools) ? r.tools : [];
  const _unc = (r.uncertainties && typeof r.uncertainties === 'object') ? r.uncertainties : {};
  const _pc = pruneAnsweredUncertainties(Array.isArray(_unc.phoneCall) ? _unc.phoneCall : (Array.isArray(r.uncertainties) ? r.uncertainties : []), r.message);
  const _os = pruneAnsweredUncertainties(Array.isArray(_unc.onSite) ? _unc.onSite : [], r.message);

  const de = distanceAndEta(r.point);
  const uc = { high: 'high', medium: 'med', low: 'low' }[r.urgency];
  const urgLabel = { high: 'High', medium: 'Medium', low: 'Low' }[r.urgency];

  // Materials: engine-inferred plus any the electrician adds. Custom ones can be removed.
  const probText = p => p === 'surely' ? 'Surely' : p === 'likely' ? 'Most likely' : 'Maybe';
  const materialsHTML = _mats.length
    ? _mats.map((m, i) => `
      <div class="mat">
        <span>${esc(m.name)}</span>
        <span class="mat-actions">
          <span class="prob ${m.prob}">${probText(m.prob)}</span>
          ${m.custom ? `<button class="mat-remove" title="Remove" aria-label="Remove material" onclick="removeMaterial('${esc(String(r.id))}', ${i})">&times;</button>` : ''}
        </span>
      </div>`).join('')
    : '<p class="missing" style="margin:0 0 4px">No materials listed yet.</p>';

  // Inline "add material" form, available on every job (including out-of-scope).
  const addMaterialUI = `
    <button type="button" class="add-mat-btn" id="addMatBtn">+ Add needed material</button>
    <div class="add-mat-form hidden" id="addMatForm">
      <input type="text" id="addMatName" placeholder="Material or tool name">
      <input type="text" id="addMatUnit" class="add-mat-unit" placeholder="Unit (e.g. each)">
      <select id="addMatProb">
        <option value="surely">Surely</option>
        <option value="likely">Most likely</option>
        <option value="maybe">Maybe</option>
      </select>
      <button type="button" class="btn btn-primary" id="addMatSave">Add</button>
    </div>`;

  // Tools list
  const toolsHTML = _tools.length > 0
    ? _tools.map(t => `<li style="padding:4px 0;font-size:.88rem">• ${esc(t)}</li>`).join('')
    : '<li style="padding:4px 0;font-size:.88rem;color:var(--muted)">Standard electrician toolkit</li>';

  // "Booked past the ideal window" flag: a yellow, first-to-check item. For in-scope jobs
  // it heads the phone-call checklist; for out-of-scope jobs (which hide the checklist) it
  // is shown as a standalone highlighted note.
  const bt = r.beyondTarget;
  const beyondTargetMsg = bt
    ? `Could not schedule within the ideal window for this ${r.urgency} priority (target: within ${bt.targetDays} working day${bt.targetDays === 1 ? '' : 's'}; booked ${bt.bookedDays} working days out). Confirm the urgency level and check the client is okay with the next available opening.`
    : '';
  const beyondClearLink = ` <a href="#" class="flag-clear" onclick="clearBeyondTarget('${esc(String(r.id))}');return false;">Mark checked</a>`;
  const beyondTargetLi = beyondTargetMsg ? `<li class="flag-urgent">${esc(beyondTargetMsg)}${beyondClearLink}</li>` : '';
  const beyondTargetNote = beyondTargetMsg ? `<div class="reschedule-note">${esc(beyondTargetMsg)}${beyondClearLink}</div>` : '';

  // Uncertainties separated into phone call vs on-site
  const phoneCallHTML = beyondTargetLi + _pc.map(u => `<li>${esc(u)}</li>`).join('');
  const onSiteHTML = _os.map(u => `<li>${esc(u)}</li>`).join('');

  const materialsSection = `<div class="divider"></div><p class="block-label">Materials needed${out ? '' : ' (ranked by confidence)'}</p>${materialsHTML}${addMaterialUI}`;
  const toolsSection = out ? '' : `<div class="divider"></div><p class="block-label">Tools required</p><ul style="list-style:none;margin:8px 0;padding:0">${toolsHTML}</ul>`;
  const prepSection = out ? '' : `<div class="divider"></div><p class="block-label">📞 Questions for booking phone call</p><ul class="checks">${phoneCallHTML}</ul><div class="divider"></div><p class="block-label">🔧 On-site checks before starting work</p><ul class="checks">${onSiteHTML}</ul>`;
  const scopeSection = out ? `<div class="divider"></div>${beyondTargetNote}<p class="msg" style="font-style:normal">This looks like a new installation or project, not a fix or repair, so it is outside the repair scope. Urgency and location are still flagged above. Materials, tools, labor, and prep questions are not estimated for out-of-scope jobs.</p>` : '';

  const avgDuration = (r.laborMin + r.laborMax) / 2 + 1;
  const slots = nextAvailable(avgDuration, 2);
  const slotsHTML = slots.length
    ? slots.map(s => `<div class="sched-row"><span class="ico">»</span><span>Open window: <span class="slot">${fmtSlot(s)}</span></span></div>`).join('')
    : `<div class="sched-row"><span class="ico">»</span><span>No standard window in next two weeks. Consider after-hours.</span></div>`;

  // Nearby = other imported requests within range (excludes this one)
  const near = nearbyScheduled(r.point, 6, r.id);
  const nearHTML = r.point
    ? (near.length
        ? near.map(n => `
          <div class="nearby-item clickable" onclick="openNearbyJob('${esc(String(n.id))}', event)" style="cursor:pointer;padding:8px;margin:2px 0;border-radius:6px;transition:background .15s" onmouseover="this.style.background='var(--canvas)'" onmouseout="this.style.background='transparent'">
            <span><strong>${esc(n.jobType)}</strong> (${esc(n.name || n.partOfHouse || 'Unknown')})</span>
            <span class="d">${n.miles.toFixed(1)} mi</span>
          </div>`).join('')
        : `<div class="nearby-item"><span>No other imported jobs within 6 miles yet.</span></div>`)
    : `<div class="nearby-item"><span class="missing">Address needed to find nearby jobs.</span></div>`;

  const etaHTML = de
    ? `<div class="eta">
         <div class="box"><div class="v">${de.miles.toFixed(1)} mi</div><div class="k">Est. road distance</div></div>
         <div class="box"><div class="v">${de.minutes} min</div><div class="k">Est. drive time</div></div>
       </div>`
    : `<p class="missing" style="margin:4px 0 0">Address not provided. Collect it to estimate distance and drive time.</p>`;

  // AI classification section. With a key configured the AI is used for every job, so a
  // re-run affordance is offered on any job that has a message. Without a key, it is only
  // shown on the jobs that most need it (the offline engine could not classify them), so
  // offline-only detail pages are not cluttered with the prompt on every request.
  const hasKey = aiConfigured();
  const aiPending = aiPendingIds.has(r.id);
  const aiError = aiErrorMessages.get(r.id);
  const showAiSection = isAiEligible(r) && (hasKey || /^not determined/i.test(r.jobType));
  const aiSection = showAiSection ? `
    <div class="divider"></div>
    <p class="block-label">AI classification</p>
    ${aiPending
      ? `<div class="ai-badge">Checking with AI...</div>`
      : `<button class="btn btn-secondary" onclick="retryAIClassification('${esc(String(r.id))}')" ${hasKey ? '' : 'disabled'}>${hasKey ? 'Re-run AI classification' : 'Try AI classification'}</button>
         ${hasKey ? '' : '<p class="missing" style="margin-top:8px">Add an AI provider and API key in Settings to enable this.</p>'}
         ${aiError ? `<p class="ai-error">${esc(aiError)}</p>` : ''}`}
  ` : '';

  // Note shown when the customer replied "No" and the job is back in Requests.
  const rescheduleNote = (r.rescheduleRequested && !r.scheduled)
    ? `<div class="reschedule-note">The customer asked to change the booking time. Contact the client to schedule a time that works for them.</div>`
    : '';

  // Schedule area: differs for unscheduled versus scheduled jobs.
  const emailBtn = (r.email && r.email.trim())
    ? `<button class="btn btn-secondary" onclick="resendBookingEmail('${esc(String(r.id))}')">Resend booking email</button>`
    : '';
  const scheduleArea = r.scheduled
    ? `<div class="card" style="margin-bottom:18px">
         <p class="block-label" style="margin-top:0">Scheduled window</p>
         <p style="font-size:1rem;font-weight:600;margin:0 0 4px">${esc(formatWindowSummary(r.scheduledStart, r.scheduledEnd))}</p>
         <p style="font-size:.85rem;color:var(--muted);margin:0 0 14px">Duration: ${esc(formatDuration(r.scheduledStart, r.scheduledEnd))}</p>
         <div style="display:flex;gap:10px;flex-wrap:wrap">
           <button class="btn btn-primary" onclick="openScheduleModal('${esc(String(r.id))}')">Reschedule</button>
           ${emailBtn}
           <button class="btn btn-secondary" onclick="customerDeclined('${esc(String(r.id))}')">Customer declined</button>
           <button class="btn btn-secondary" onclick="unscheduleJob('${esc(String(r.id))}')">Unschedule</button>
         </div>
       </div>`
    : `<div class="card" style="margin-bottom:18px">
         <p class="block-label" style="margin-top:0">Scheduling</p>
         ${rescheduleNote}
         <p style="font-size:.9rem;color:var(--ink-soft);margin:0 0 14px">Not scheduled yet.</p>
         <button class="btn btn-primary" onclick="openScheduleModal('${esc(String(r.id))}')">Schedule</button>
       </div>`;

  document.getElementById('detail').innerHTML = `
    <button class="back" id="backBtn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      ${detailOriginScreen === 'scheduled' ? 'Back to scheduled services' : 'Back to all requests'}
    </button>


    <div class="detail-head u-${uc}">
      <div>
        <p class="eyebrow">Service request detail</p>
        <h2>${esc(r.jobType)}</h2>
        <div class="where">${esc(r.partOfHouse)} · ${r.name ? esc(r.name) : 'Customer name not provided'}</div>
      </div>
      <span class="pill ${uc}" style="font-size:.82rem;padding:6px 14px">${urgLabel} urgency</span>
    </div>


    ${scheduleArea}


    <div class="grid">
      <div class="card">
        <h3><span class="num">1</span> Job & customer</h3>
        <dl class="kv">
          <dt>Customer</dt><dd>${r.name ? esc(r.name) : '<span class="missing">Not provided</span>'}</dd>
          <dt>Requested</dt><dd>${r.requestedDate ? esc(formatRequestedDate(r.requestedDate)) : '<span class="missing">Not provided</span>'}</dd>
          <dt>Address</dt><dd>${r.address ? esc(r.address) : '<span class="missing">Not provided</span>'}</dd>
          <dt>Phone</dt><dd class="mono">${r.phone ? esc(r.phone) : '<span class="missing">Not provided</span>'}</dd>
          <dt>Email</dt><dd class="mono">${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '<span class="missing">Not provided</span>'}</dd>
          <dt>Job type</dt><dd>${esc(r.jobType)}</dd>
          <dt>Part of house</dt><dd>${esc(r.partOfHouse)}</dd>
          <dt>Urgency</dt><dd><span class="pill ${uc}">${urgLabel}</span></dd>
          <dt>Est. labor</dt><dd class="mono">${out ? '<span class="missing">Not applicable (out of repair scope)</span>' : r.laborMin + '-' + r.laborMax + ' hours'}</dd>
        </dl>


        <div class="divider"></div>
        <p class="block-label">Customer's message</p>
        <p class="msg">${esc(r.message)}</p>
        ${aiSection}


        <div class="divider"></div>
        <p class="block-label">Distance & ETA from base</p>
        ${etaHTML}


        ${scopeSection}${materialsSection}${toolsSection}${prepSection}
      </div>


      <div class="card">
        <h3><span class="num">2</span> Scheduling insights</h3>
        <p class="block-label">Next available on your calendar</p>
        ${slotsHTML}


        <div class="divider"></div>
        <p class="block-label">Other nearby jobs (within 6 mi) - click to view</p>
        ${nearHTML}


        <div class="divider"></div>
        <p class="block-label">Routing note</p>
        <p style="font-size:.85rem;color:var(--ink-soft);margin:0">
          ${r.point
            ? (near.length
                ? `You have ${near.length} job${near.length > 1 ? 's' : ''} near this address. Grouping on the same day could cut drive time.`
                : `No nearby jobs yet. Try to batch this with another request in the same area when one comes in.`)
            : `Add the customer's address to enable routing and nearby-job suggestions.`}
        </p>
      </div>
    </div>


    <div class="note">
      Job type, urgency, part of house, materials, tools, labor hours and scheduling are AI-inferred estimates.
      A licensed electrician should confirm everything on site. Distance and drive time are approximate.
    </div>
  `;

  document.getElementById('backBtn').addEventListener('click', backToList);

  // Wire the "Add needed material" form (present on every job).
  const addMatBtn = document.getElementById('addMatBtn');
  if (addMatBtn) {
    const form = document.getElementById('addMatForm');
    addMatBtn.addEventListener('click', () => {
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) document.getElementById('addMatName').focus();
    });
    document.getElementById('addMatSave').addEventListener('click', () => addCustomMaterial(r.id));
    document.getElementById('addMatName').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addCustomMaterial(r.id); }
    });
  }

  document.getElementById('overview').classList.add('hidden');
  document.getElementById('purchase').classList.add('hidden');
  document.getElementById('detail').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


// Add an electrician-entered material (name + likelihood, default Surely) to a job.
function addCustomMaterial(jobId) {
  const job = findJob(jobId);
  if (!job) return;
  const nameEl = document.getElementById('addMatName');
  const name = (nameEl.value || '').trim();
  if (!name) { nameEl.focus(); return; }
  const prob = document.getElementById('addMatProb').value || 'surely';
  const unit = (document.getElementById('addMatUnit').value || '').trim();
  if (!Array.isArray(job.materials)) job.materials = [];
  const mat = { name, prob, custom: true };
  if (unit) mat.unit = unit;
  job.materials.push(mat);
  saveData();
  openDetail(job.id);
}


// Remove a custom-added material (engine-inferred materials are not removable).
function removeMaterial(jobId, index) {
  const job = findJob(jobId);
  if (!job || !Array.isArray(job.materials)) return;
  const m = job.materials[index];
  if (!m || !m.custom) return;
  job.materials.splice(index, 1);
  saveData();
  openDetail(job.id);
}


// Switch to a screen (Requests or Scheduled), leaving the detail view if one is open.
// Used by the sidebar nav and by Back, so navigating away from a detail page always
// lands on the right list instead of leaving a hidden, stale screen behind it.
function goToScreen(screen) {
  appState.currentScreen = screen;
  currentDetailId = null;
  document.getElementById('detail').classList.add('hidden');
  const purchase = screen === 'purchase';
  document.getElementById('purchase').classList.toggle('hidden', !purchase);
  document.getElementById('overview').classList.toggle('hidden', purchase);
  updateUI();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


// Return from a detail page to whichever screen it was opened from.
function backToList() {
  goToScreen(detailOriginScreen);
}


// Navigate to a nearby request's detail page
function openNearbyJob(requestId, event) {
  if (event) event.stopPropagation();
  // Inline onclick passes the id as a string; compare ids as strings to be safe.
  const req = appState.requests.find(x => String(x.id) === String(requestId));
  if (req) openDetail(req.id);
}


// ============ CALENDAR & SCHEDULING ============
function atDay(offset, hour, min) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, min || 0, 0, 0);
  return d;
}


// A specific day offset at a fractional hour (8.5 becomes 08:30).
function atDayFrac(offset, fractionalHour) {
  const h = Math.floor(fractionalHour);
  const min = Math.round((fractionalHour - h) * 60);
  return atDay(offset, h, min);
}


// Business hours and lunch, read live from settings so the whole app agrees.
function bizStartHour() { return appState.settings.businessStartHour; }
function bizEndHour() { return appState.settings.businessEndHour; }
function lunchActive() { return !!appState.settings.lunchEnabled; }
function lunchStartHour() { return timeStrToHour(appState.settings.lunchStart); }
function lunchEndHour() { return timeStrToHour(appState.settings.lunchEnd); }


// Mock calendar - used for "next available" scheduling slots only
const CALENDAR = [
  { id: 'cal1', title: 'Panel inspection', city: 'Carmel', point: { lat: 39.9784, lng: -86.1180 }, start: atDay(0, 9, 0), end: atDay(0, 11, 0) },
  { id: 'cal2', title: 'Outlet install', city: 'Westfield', point: { lat: 40.0428, lng: -86.1275 }, start: atDay(0, 13, 0), end: atDay(0, 15, 0) },
  { id: 'cal3', title: 'Ceiling fan swap', city: 'Fishers', point: { lat: 39.9568, lng: -85.9686 }, start: atDay(1, 8, 30), end: atDay(1, 11, 30) },
  { id: 'cal4', title: 'Breaker replacement', city: 'Noblesville', point: { lat: 40.0456, lng: -86.0086 }, start: atDay(1, 14, 0), end: atDay(1, 16, 0) },
];


// Nearby = other imported requests near a point, excluding the current one
function nearbyScheduled(point, radius, excludeId) {
  if (!point) return [];
  return appState.requests
    .filter(req => req.id !== excludeId && req.point)
    .map(req => ({ ...req, miles: straightLineMiles(point, req.point) * 1.3 }))
    .filter(req => req.miles <= radius)
    .sort((a, b) => a.miles - b.miles);
}


// Find the next `count` open start times that could fit a job of `durationHrs`, scanning
// forward over the next two weeks around weekends, lunch and existing bookings. Used for
// the "Next available on your calendar" hints on the job detail page.
function nextAvailable(durationHrs, count) {
  const slots = [];
  const needMs = durationHrs * 3600 * 1000;
  let cursor = new Date();
  cursor.setMinutes(0, 0, 0);
  if (cursor.getHours() < bizStartHour()) cursor.setHours(Math.floor(bizStartHour()), 0, 0, 0);

  for (let day = 0; day < 14 && slots.length < count; day++) {
    const dayStart = atDayFrac(day, bizStartHour());
    const dayEnd = atDayFrac(day, bizEndHour());
    const dow = dayStart.getDay();
    if (dow === 0 || dow === 6) continue;

    // Only block lunch when the setting is on.
    const busy = lunchActive()
      ? [{ start: atDayFrac(day, lunchStartHour()), end: atDayFrac(day, lunchEndHour()) }]
      : [];
    CALENDAR.forEach(c => {
      if (c.start.toDateString() === dayStart.toDateString()) busy.push({ start: c.start, end: c.end });
    });
    busy.sort((a, b) => a.start - b.start);

    let open = new Date(Math.max(dayStart, cursor));
    for (const b of busy) {
      if (b.start - open >= needMs && open >= dayStart) {
        slots.push(new Date(open));
        if (slots.length >= count) break;
      }
      if (b.end > open) open = new Date(b.end);
    }
    if (slots.length < count && dayEnd - open >= needMs && open >= dayStart) {
      slots.push(new Date(open));
    }
  }
  return slots;
}


// Format a slot Date as a short "Mon, Jul 6, 9:00 AM" label for the availability hints.
function fmtSlot(d) {
  const day = d.toLocaleDateString(DATE_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}


// ============ JOB SCHEDULING (Scheduled Services screen) ============

// Point-to-point travel time between two jobs (mirrors distanceAndEta, which is base-to-point).
function travelMinutesBetween(aPoint, bPoint) {
  if (!aPoint || !bPoint) return 0;
  const straight = straightLineMiles(aPoint, bPoint);
  const roadMiles = straight * 1.3;
  return Math.max(4, Math.round(roadMiles / 32 * 60));
}


// The scheduled job whose window ends most recently before candidateStart, or null.
function previousJobBefore(candidateStart) {
  let best = null;
  appState.requests.forEach(job => {
    if (!job.scheduled || !job.scheduledEnd) return;
    const end = new Date(job.scheduledEnd);
    if (end <= candidateStart && (!best || end > new Date(best.scheduledEnd))) {
      best = job;
    }
  });
  return best;
}


// Window length in hours for a job's service time: labor midpoint, or a placeholder
// when out of scope or zero-labor.
function laborMidHours(job) {
  if (job.inScope === false || !job.laborMin || !job.laborMax) return PLACEHOLDER_WINDOW_HOURS;
  const mid = (job.laborMin + job.laborMax) / 2;
  return mid > 0 ? mid : PLACEHOLDER_WINDOW_HOURS;
}


// Sum of scheduled job window lengths (service plus travel; excludes buffer and lunch)
// for all jobs scheduled on the same calendar day as dateLike.
function dayScheduledMinutes(dateLike) {
  const target = new Date(dateLike).toDateString();
  let total = 0;
  appState.requests.forEach(job => {
    if (!job.scheduled || !job.scheduledStart || !job.scheduledEnd) return;
    const start = new Date(job.scheduledStart);
    if (start.toDateString() !== target) return;
    total += (new Date(job.scheduledEnd) - start) / 60000;
  });
  return total;
}


// Round a date up to the next slot boundary (15 minutes).
function roundUpToSlot(date) {
  const ms = SLOT_GRANULARITY_MINUTES * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}


// True if [aStart, aEnd) overlaps [bStart, bEnd).
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}


// Scan the schedule horizon for the earliest window that fits this job's required length,
// inside business hours, routed around other scheduled jobs (with buffer) and lunch (if
// enabled), without busting the daily cap. Returns { start, end } or null.
// ---------- Deadline (target scheduling window) helpers ----------
// Ideal booking window in WORKING days, by priority. High urgency always uses the high
// value (even for non-repair jobs); other non-repair jobs use the non-repair value.
function targetDeadlineDays(job) {
  const s = appState.settings;
  if (job.urgency === 'high') return numOr(s.deadlineHighDays, 1);
  if (job.inScope === false) return numOr(s.deadlineNonRepairDays, 14);
  if (job.urgency === 'medium') return numOr(s.deadlineMediumDays, 3);
  return numOr(s.deadlineLowDays, 7);
}

// Count working days (Mon-Fri) strictly after `from`'s date up to and including `to`'s
// date. Same-day is 0; the next weekday is 1.
function workingDaysBetween(from, to) {
  const a = new Date(from); a.setHours(0, 0, 0, 0);
  const b = new Date(to); b.setHours(0, 0, 0, 0);
  if (b <= a) return 0;
  let count = 0;
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// Set or clear the "booked later than the ideal window" flag on a scheduled job. Stores
// the target vs booked working-day counts so the detail page can explain the gap.
function applyBeyondTargetFlag(job) {
  if (!job.scheduled || !job.scheduledStart) { job.beyondTarget = null; return; }
  const targetDays = targetDeadlineDays(job);
  const bookedDays = workingDaysBetween(new Date(), new Date(job.scheduledStart));
  job.beyondTarget = bookedDays > targetDays ? { targetDays, bookedDays } : null;
}

// Manual "Mark checked" clear for the beyond-target flag (after confirming with the client).
function clearBeyondTarget(id) {
  const job = findJob(id);
  if (!job) return;
  job.beyondTarget = null;
  saveData();
  if (currentDetailId === job.id && !document.getElementById('detail').classList.contains('hidden')) openDetail(job.id);
  else updateUI();
}

// The base location's coordinates, used as the day's starting point for routing.
function basePoint() { return appState.settings.baseCoordinates || null; }

// The scheduled job that starts first at or after candidateStart on the same day, or null.
function nextJobAfter(candidateStart) {
  let best = null;
  appState.requests.forEach(job => {
    if (!job.scheduled || !job.scheduledStart) return;
    const s = new Date(job.scheduledStart);
    if (s.toDateString() !== candidateStart.toDateString()) return;
    if (s >= candidateStart && (!best || s < new Date(best.scheduledStart))) best = job;
  });
  return best;
}

// Extra driving (minutes) that inserting `job` at candidateStart adds to that day's route,
// relative to the neighbours it sits between (base is the day's start point).
function addedDriveMinutes(job, candidateStart) {
  if (!job.point) return 0;
  const prevJob = previousJobBefore(candidateStart);
  const prevPt = (prevJob && prevJob.point) ? prevJob.point : basePoint();
  if (!prevPt) return 0;
  const nextJob = nextJobAfter(candidateStart);
  const nextPt = (nextJob && nextJob.point) ? nextJob.point : null;
  const toJob = travelMinutesBetween(prevPt, job.point);
  if (!nextPt) return toJob;
  return Math.max(0, toJob + travelMinutesBetween(job.point, nextPt) - travelMinutesBetween(prevPt, nextPt));
}

// All feasible start slots for `job` on the given day offset (one per open gap), each with
// its added drive time. Honors business hours, lunch, other bookings (+buffer), daily cap.
function feasibleSlotsForDay(job, day) {
  const dayStart = atDayFrac(day, bizStartHour());
  const dayEnd = atDayFrac(day, bizEndHour());
  const dow = dayStart.getDay();
  if (dow === 0 || dow === 6) return [];

  const lengthMs = laborMidHours(job) * 3600 * 1000;
  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  const capMinutes = appState.settings.dailyCapHours * 60;

  const busy = [];
  if (lunchActive()) busy.push({ start: atDayFrac(day, lunchStartHour()), end: atDayFrac(day, lunchEndHour()) });
  appState.requests.forEach(other => {
    if (other.id === job.id || !other.scheduled || !other.scheduledStart || !other.scheduledEnd) return;
    if (new Date(other.scheduledStart).toDateString() !== dayStart.toDateString()) return;
    busy.push({
      start: new Date(new Date(other.scheduledStart).getTime() - bufferMs),
      end: new Date(new Date(other.scheduledEnd).getTime() + bufferMs)
    });
  });
  busy.sort((a, b) => a.start - b.start);

  const slots = [];
  const fits = candidate => {
    const prev = previousJobBefore(candidate);
    const travelMs = prev && prev.point && job.point ? travelMinutesBetween(prev.point, job.point) * 60000 : 0;
    const windowEnd = new Date(candidate.getTime() + lengthMs + travelMs);
    const usedMinutes = dayScheduledMinutes(candidate) + (lengthMs + travelMs) / 60000;
    return { windowEnd, usedMinutes, ok: windowEnd <= dayEnd && usedMinutes <= capMinutes && candidate >= dayStart };
  };

  let candidate = roundUpToSlot(new Date(Math.max(dayStart, day === 0 ? new Date() : dayStart)));
  if (candidate < dayStart) candidate = dayStart;
  for (const b of busy) {
    if (candidate < b.start) {
      const f = fits(candidate);
      if (f.ok && f.windowEnd <= b.start) {
        slots.push({ start: new Date(candidate), end: f.windowEnd, day, addedDrive: addedDriveMinutes(job, candidate) });
      }
    }
    if (b.end > candidate) candidate = roundUpToSlot(b.end);
  }
  const f = fits(candidate);
  if (f.ok) slots.push({ start: new Date(candidate), end: f.windowEnd, day, addedDrive: addedDriveMinutes(job, candidate) });
  return slots;
}

// Suggest a window: prefer slots inside the job's target working-day window and, among
// those, the one that adds the least driving; if none fit the target, take the earliest
// available slot after it (least delay).
function proposeWindow(job) {
  const targetDays = targetDeadlineDays(job);
  const now = new Date();
  const within = [];
  const beyond = [];
  for (let day = 0; day < SCHEDULE_HORIZON_DAYS; day++) {
    feasibleSlotsForDay(job, day).forEach(s => {
      (workingDaysBetween(now, s.start) <= targetDays ? within : beyond).push(s);
    });
  }
  const leastDrive = arr => arr.reduce((best, s) =>
    (!best || s.addedDrive < best.addedDrive || (s.addedDrive === best.addedDrive && s.start < best.start)) ? s : best, null);
  const earliest = arr => arr.reduce((best, s) =>
    (!best || s.start < best.start || (s.start.getTime() === best.start.getTime() && s.addedDrive < best.addedDrive)) ? s : best, null);
  const chosen = within.length ? leastDrive(within) : earliest(beyond);
  return chosen ? { start: chosen.start, end: chosen.end } : null;
}


// ---------- 2-opt route polishing (auto-scheduler, only when moving booked jobs) ----------
// Total base-to-stops driving (minutes) for a given visiting order.
function routeDriveMinutes(order) {
  let total = 0, prev = basePoint();
  for (const j of order) { if (prev && j.point) total += travelMinutesBetween(prev, j.point); prev = j.point || prev; }
  return total;
}

// Classic 2-opt: repeatedly reverse an order segment while it shortens the route (base is a
// fixed start), until no reversal helps. Returns a (possibly) shorter ordering of the same jobs.
function twoOptOrder(order) {
  if (order.length < 3) return order.slice();
  let best = order.slice();
  let bestDrive = routeDriveMinutes(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const d = routeDriveMinutes(cand);
        if (d < bestDrive - 1e-9) { best = cand; bestDrive = d; improved = true; }
      }
    }
  }
  return best;
}

// Calendar day offset (today = 0) for a date, for use with atDayFrac.
function dayOffsetOf(date) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(date); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

// Lay out orderedJobs sequentially on `day`, around lunch and any scheduled jobs NOT in this
// set, reserving travel from the previous stop plus a buffer. Returns per-job {job,start,end},
// or null if the order does not fit the day.
function packDayInOrder(orderedJobs, day) {
  const dayStart = atDayFrac(day, bizStartHour());
  const dayEnd = atDayFrac(day, bizEndHour());
  const bufferMs = BUFFER_MINUTES * 60000;
  const capMinutes = appState.settings.dailyCapHours * 60;
  const ids = new Set(orderedJobs.map(j => j.id));
  const fixed = [];
  if (lunchActive()) fixed.push({ start: atDayFrac(day, lunchStartHour()), end: atDayFrac(day, lunchEndHour()) });
  appState.requests.forEach(o => {
    if (ids.has(o.id) || !o.scheduled || !o.scheduledStart || !o.scheduledEnd) return;
    if (new Date(o.scheduledStart).toDateString() !== dayStart.toDateString()) return;
    fixed.push({ start: new Date(new Date(o.scheduledStart).getTime() - bufferMs), end: new Date(new Date(o.scheduledEnd).getTime() + bufferMs) });
  });
  fixed.sort((a, b) => a.start - b.start);

  const out = [];
  let cursor = roundUpToSlot(new Date(Math.max(dayStart, day === 0 ? new Date() : dayStart)));
  let workMinutes = 0;
  let prevPoint = basePoint();
  for (const job of orderedJobs) {
    const lengthMs = laborMidHours(job) * 3600000;
    const travelMs = (prevPoint && job.point) ? travelMinutesBetween(prevPoint, job.point) * 60000 : 0;
    let placed = false, guard = 0;
    while (!placed && guard++ < 200) {
      cursor = roundUpToSlot(cursor);
      const end = new Date(cursor.getTime() + lengthMs + travelMs);
      const clash = fixed.find(f => cursor < f.end && end > f.start);
      if (clash) { cursor = roundUpToSlot(clash.end); continue; }
      if (end > dayEnd) return null;
      workMinutes += (lengthMs + travelMs) / 60000;
      if (workMinutes > capMinutes) return null;
      out.push({ job, start: new Date(cursor), end });
      cursor = new Date(end.getTime() + bufferMs);
      prevPoint = job.point || prevPoint;
      placed = true;
    }
    if (!placed) return null;
  }
  return out;
}

// After greedy placement, improve each day's visiting order with 2-opt and re-time the
// day's stops. Only called when the "move booked jobs" setting is on (it re-times jobs).
function twoOptPolishPlan(plan) {
  const byDay = {};
  plan.forEach(p => { if (p.none) return; const key = new Date(p.start).toDateString(); (byDay[key] = byDay[key] || []).push(p); });
  const now = new Date();
  Object.keys(byDay).forEach(key => {
    const entries = byDay[key].sort((a, b) => a.start - b.start);
    if (entries.length < 3) return;
    const order = entries.map(p => p.job);
    const improvedOrder = twoOptOrder(order);
    if (routeDriveMinutes(improvedOrder) >= routeDriveMinutes(order) - 1e-9) return; // no gain
    const packed = packDayInOrder(improvedOrder, dayOffsetOf(entries[0].start));
    if (!packed) return; // reordered layout did not fit; keep the greedy result
    packed.forEach(pk => {
      const entry = entries.find(p => p.job === pk.job);
      entry.start = pk.start;
      entry.end = pk.end;
      pk.job.scheduledStart = pk.start.toISOString();
      pk.job.scheduledEnd = pk.end.toISOString();
      entry.addedDrive = addedDriveMinutes(pk.job, pk.start);
      const targetDays = targetDeadlineDays(pk.job);
      const bookedDays = workingDaysBetween(now, pk.start);
      entry.beyond = bookedDays > targetDays ? { targetDays, bookedDays } : null;
    });
  });
}


// ---------- Auto-scheduler (whole-schedule planner) ----------
let pendingAutoPlan = null;

// Build a proposed schedule for all unscheduled routable jobs (and, when the setting
// allows, re-plan already-booked ones too), ordered by urgency deadline then greedily
// inserted to minimize driving. Nothing is committed until the preview is applied.
function autoScheduleAll() {
  const movable = !!appState.settings.allowMoveBooked;
  const all = appState.requests.filter(isAiEligible);
  const pool = all.filter(j => j.point && (movable ? true : !j.scheduled));
  const skipped = all.filter(j => !j.point && (movable ? true : !j.scheduled));
  if (pool.length === 0) {
    alert(skipped.length
      ? 'The unscheduled jobs have no address on file, so they cannot be routed. Add addresses to auto-schedule them.'
      : 'There are no jobs to auto-schedule.');
    return;
  }

  const urgRank = { high: 0, medium: 1, low: 2 };
  const ordered = pool.slice().sort((a, b) =>
    targetDeadlineDays(a) - targetDeadlineDays(b)
    || (urgRank[a.urgency] - urgRank[b.urgency])
    || (new Date(a.requestedDate || 0) - new Date(b.requestedDate || 0)));

  // Snapshot so we can revert after tentative placement.
  const snapshot = ordered.map(j => ({ j, scheduled: j.scheduled, s: j.scheduledStart, e: j.scheduledEnd, bt: j.beyondTarget }));
  const wasBooked = new Map(snapshot.map(x => [x.j, x.scheduled]));
  // If moving booked jobs is allowed, clear them first so they get re-placed.
  if (movable) ordered.forEach(j => { j.scheduled = false; j.scheduledStart = null; j.scheduledEnd = null; });

  const now = new Date();
  const plan = [];
  ordered.forEach(job => {
    const w = proposeWindow(job);
    if (!w) { plan.push({ job, none: true }); return; }
    job.scheduled = true;
    job.scheduledStart = w.start.toISOString();
    job.scheduledEnd = w.end.toISOString();
    const targetDays = targetDeadlineDays(job);
    const bookedDays = workingDaysBetween(now, w.start);
    plan.push({
      job, start: w.start, end: w.end,
      addedDrive: addedDriveMinutes(job, w.start),
      beyond: bookedDays > targetDays ? { targetDays, bookedDays } : null,
      moved: movable && wasBooked.get(job)
    });
  });

  // When allowed to move booked jobs, polish each day's visiting order with 2-opt to trim
  // driving further (this re-times stops, which is why it is gated to that setting).
  if (movable) twoOptPolishPlan(plan);

  // Revert to the pre-plan state; the plan is applied only on user confirmation.
  snapshot.forEach(s => { s.j.scheduled = s.scheduled; s.j.scheduledStart = s.s; s.j.scheduledEnd = s.e; s.j.beyondTarget = s.bt; });

  pendingAutoPlan = { plan, skipped };
  showAutoPlanPreview(pendingAutoPlan);
}


// Render the auto-schedule preview modal: a per-job list of proposed windows with urgency
// pills and "past target" / "re-timed, re-email" flags, plus a summary of jobs placed,
// added driving, and any that could not fit or were skipped for lack of an address.
function showAutoPlanPreview(data) {
  const placed = data.plan.filter(p => !p.none);
  const unplaced = data.plan.filter(p => p.none);
  const totalDrive = placed.reduce((sum, p) => sum + (p.addedDrive || 0), 0);

  const rows = placed.map(p => `
    <div class="autoplan-row">
      <div class="autoplan-when">${esc(formatWindowSummary(p.start.toISOString(), p.end.toISOString()))}</div>
      <div class="autoplan-job">${esc(p.job.jobType)}${p.job.name ? ' &middot; ' + esc(p.job.name) : ''}
        <span class="pill ${URG_CLASS[p.job.urgency]}" style="font-size:.7rem;padding:2px 8px">${esc(p.job.urgency)}</span>
        ${p.beyond ? '<span class="autoplan-flag">past target</span>' : ''}
        ${p.moved ? '<span class="autoplan-flag autoplan-flag-move">re-timed, re-email</span>' : ''}
      </div>
    </div>`).join('');

  const notes = [`${placed.length} job${placed.length === 1 ? '' : 's'} placed`];
  if (totalDrive > 0) notes.push(`about ${Math.round(totalDrive)} min of added driving`);
  if (unplaced.length) notes.push(`${unplaced.length} could not fit the next ${SCHEDULE_HORIZON_DAYS} days`);
  if (data.skipped.length) notes.push(`${data.skipped.length} skipped (no address)`);

  document.getElementById('autoPlanBody').innerHTML = `
    <p style="margin:0 0 12px;color:var(--ink-soft);font-size:.9rem">${esc(notes.join(' · '))}. Booking emails are not sent automatically; send them from each job after applying.</p>
    ${rows || '<p class="missing">No jobs could be placed.</p>'}
    ${unplaced.length ? `<p class="missing" style="margin-top:10px">Could not fit: ${unplaced.map(p => esc(p.job.jobType)).join(', ')}.</p>` : ''}
    ${data.skipped.length ? `<p class="missing" style="margin-top:6px">No address (skipped): ${data.skipped.map(j => esc(j.jobType)).join(', ')}.</p>` : ''}`;

  document.getElementById('autoPlanApplyBtn').disabled = placed.length === 0;
  openModal('autoPlanModal');
}


// Commit the previewed auto-schedule: write each proposed window onto its job, set the
// beyond-target flag where a booking missed its ideal window, and switch to the Scheduled
// screen. Booking emails are intentionally not opened here (that would spawn many drafts).
function applyAutoPlan() {
  if (!pendingAutoPlan) return;
  pendingAutoPlan.plan.forEach(p => {
    if (p.none) return;
    p.job.scheduled = true;
    p.job.scheduledStart = p.start.toISOString();
    p.job.scheduledEnd = p.end.toISOString();
    p.job.rescheduleRequested = false;
    p.job.beyondTarget = p.beyond || null;
  });
  saveData();
  pendingAutoPlan = null;
  closeModal('autoPlanModal');
  appState.currentScreen = 'scheduled';
  updateUI();
}


// Hard errors block confirm; soft warnings allow override.
function evaluateWindow(job, start, end) {
  const errors = [];
  const warnings = [];

  if (!(start instanceof Date) || !(end instanceof Date) || isNaN(start) || isNaN(end)) {
    errors.push('Start and end must be valid dates.');
    return { errors, warnings };
  }
  if (end <= start) {
    errors.push('End must be after start.');
    return { errors, warnings };
  }

  const dow = start.getDay();
  if (dow === 0 || dow === 6) warnings.push('This falls on a weekend.');

  const dayStart = atDayFracOnDate(start, bizStartHour());
  const dayEnd = atDayFracOnDate(start, bizEndHour());
  if (start < dayStart || end > dayEnd) warnings.push('This window falls outside business hours.');

  if (lunchActive()) {
    const lunchS = atDayFracOnDate(start, lunchStartHour());
    const lunchE = atDayFracOnDate(start, lunchEndHour());
    if (rangesOverlap(start, end, lunchS, lunchE)) warnings.push('This window overlaps the lunch block.');
  }

  const bufferMs = BUFFER_MINUTES * 60 * 1000;
  appState.requests.forEach(other => {
    if (other.id === job.id || !other.scheduled || !other.scheduledStart || !other.scheduledEnd) return;
    const oStart = new Date(other.scheduledStart);
    const oEnd = new Date(other.scheduledEnd);
    if (rangesOverlap(start, end, oStart, oEnd)) {
      warnings.push(`This window overlaps another scheduled job (${esc(other.jobType)}).`);
    } else if (rangesOverlap(start, end, new Date(oStart.getTime() - bufferMs), new Date(oEnd.getTime() + bufferMs))) {
      warnings.push(`This window leaves less than the ${BUFFER_MINUTES} minute buffer around another scheduled job (${esc(other.jobType)}).`);
    }
  });

  const existingMinutes = dayScheduledMinutes(start) - currentJobMinutesOnDay(job, start);
  const thisMinutes = (end - start) / 60000;
  const capMinutes = appState.settings.dailyCapHours * 60;
  if (existingMinutes + thisMinutes > capMinutes) warnings.push('This window pushes the day over the daily work cap.');

  return { errors, warnings };
}


// Minutes this job currently contributes to its own scheduled day (excluded when
// re-evaluating an edit so the job is not double counted against the cap).
function currentJobMinutesOnDay(job, dateLike) {
  if (!job.scheduled || !job.scheduledStart || !job.scheduledEnd) return 0;
  const start = new Date(job.scheduledStart);
  if (start.toDateString() !== new Date(dateLike).toDateString()) return 0;
  return (new Date(job.scheduledEnd) - start) / 60000;
}


// Same as atDayFrac, but anchored to the calendar day of a given date rather than an offset.
function atDayFracOnDate(date, fractionalHour) {
  const h = Math.floor(fractionalHour);
  const min = Math.round((fractionalHour - h) * 60);
  const d = new Date(date);
  d.setHours(h, min, 0, 0);
  return d;
}


// ---------- Schedule modal ----------

// Open the schedule/reschedule modal for a job: pre-fill it with the existing window (when
// rescheduling) or the suggested least-driving window from proposeWindow, and show the
// live feasibility warnings.
function openScheduleModal(id) {
  const job = findJob(id);
  if (!job) return;
  schedulingJobId = job.id;

  document.getElementById('schedTitle').textContent = job.scheduled ? 'Reschedule service' : 'Schedule service';

  const proposed = proposeWindow(job);
  if (proposed) {
    document.getElementById('schedRationale').textContent =
      `Suggested window: ${formatWindowSummary(proposed.start, proposed.end)}. Adjust the fields below or use the suggestion as-is.`;
  } else {
    document.getElementById('schedRationale').textContent =
      `No open window was found in the next ${SCHEDULE_HORIZON_DAYS} days. Enter a window by hand below.`;
  }

  const startInput = document.getElementById('schedStart');
  const endInput = document.getElementById('schedEnd');
  if (job.scheduled && job.scheduledStart && job.scheduledEnd) {
    startInput.value = toDatetimeLocalValue(new Date(job.scheduledStart));
    endInput.value = toDatetimeLocalValue(new Date(job.scheduledEnd));
  } else if (proposed) {
    startInput.value = toDatetimeLocalValue(proposed.start);
    endInput.value = toDatetimeLocalValue(proposed.end);
  } else {
    startInput.value = '';
    endInput.value = '';
  }

  document.getElementById('schedSuggestBtn').classList.toggle('hidden', !proposed);
  refreshScheduleWarnings();
  openModal('scheduleModal');
}


// Fill in the suggested window when the user clicks "Use suggested window".
function applySuggestedWindow() {
  const job = appState.requests.find(x => x.id === schedulingJobId);
  if (!job) return;
  const proposed = proposeWindow(job);
  if (!proposed) return;
  document.getElementById('schedStart').value = toDatetimeLocalValue(proposed.start);
  document.getElementById('schedEnd').value = toDatetimeLocalValue(proposed.end);
  refreshScheduleWarnings();
}


// When the start changes, recompute the end so the window keeps the job's required length.
function onScheduleStartChange() {
  const job = appState.requests.find(x => x.id === schedulingJobId);
  if (!job) return;
  const startVal = document.getElementById('schedStart').value;
  if (!startVal) return;
  const start = new Date(startVal);
  if (isNaN(start)) return;

  const lengthHours = laborMidHours(job);
  const prev = previousJobBefore(start);
  const travelMin = prev && prev.point && job.point ? travelMinutesBetween(prev.point, job.point) : 0;
  const end = new Date(start.getTime() + (lengthHours * 60 + travelMin) * 60 * 1000);
  document.getElementById('schedEnd').value = toDatetimeLocalValue(end);
  refreshScheduleWarnings();
}


// Re-run evaluateWindow against the current form values and render errors/warnings.
function refreshScheduleWarnings() {
  const job = appState.requests.find(x => x.id === schedulingJobId);
  const warnEl = document.getElementById('schedWarn');
  const confirmBtn = document.getElementById('schedConfirmBtn');
  if (!job) { warnEl.innerHTML = ''; return; }

  const startVal = document.getElementById('schedStart').value;
  const endVal = document.getElementById('schedEnd').value;
  if (!startVal || !endVal) {
    warnEl.innerHTML = '';
    confirmBtn.disabled = false;
    return;
  }

  const { errors, warnings } = evaluateWindow(job, new Date(startVal), new Date(endVal));
  const items = [
    ...errors.map(e => `<li style="color:var(--high)">${esc(e)}</li>`),
    ...warnings.map(w => `<li style="color:var(--med-text)">${esc(w)}</li>`)
  ];
  warnEl.innerHTML = items.length
    ? `<ul style="list-style:none;margin:0;padding:0;font-size:.84rem;display:flex;flex-direction:column;gap:4px">${items.join('')}</ul>`
    : '';
  confirmBtn.disabled = errors.length > 0;
}


// Commit the chosen window: mark the job scheduled and move it to the Scheduled screen.
function confirmSchedule() {
  const job = appState.requests.find(x => x.id === schedulingJobId);
  if (!job) return;

  const startVal = document.getElementById('schedStart').value;
  const endVal = document.getElementById('schedEnd').value;
  if (!startVal || !endVal) {
    alert('Enter a start and end time before confirming.');
    return;
  }
  const start = new Date(startVal);
  const end = new Date(endVal);
  const { errors } = evaluateWindow(job, start, end);
  if (errors.length > 0) {
    alert(errors.join(' '));
    return;
  }

  job.scheduled = true;
  job.scheduledStart = start.toISOString();
  job.scheduledEnd = end.toISOString();
  job.rescheduleRequested = false; // a fresh booking clears any prior "please reschedule"
  applyBeyondTargetFlag(job); // flag if this window misses the job's ideal deadline
  saveData();
  closeModal('scheduleModal');

  // Offer to email the customer their confirmed window (opens the electrician's mail
  // client with a prefilled message; nothing is sent automatically, and it is skipped
  // when no email is on file).
  sendBookingEmail(job);

  appState.currentScreen = 'scheduled';
  if (currentDetailId === job.id) {
    openDetail(job.id);
  } else {
    updateUI();
  }
}


// Open the electrician's mail client with a prefilled booking confirmation. Browser-only,
// so this drafts the email for the electrician to send; it cannot send or read replies.
// The message asks the customer to reply "No" to change the time (see customerDeclined).
function sendBookingEmail(job) {
  if (!job || !job.email || !job.email.trim()) return;
  const business = (appState.settings.businessName || 'Your electrician').trim();
  const windowText = formatWindowSummary(job.scheduledStart, job.scheduledEnd);
  const greeting = job.name ? `Hi ${job.name},` : 'Hello,';
  const subject = `Your appointment: ${windowText}`;
  const body = [
    greeting,
    '',
    `Your ${job.jobType} appointment is booked for:`,
    windowText,
    '',
    'If this time works for you, no reply is needed.',
    'Reply No if you wish to change the booking time and we will find another slot.',
    '',
    'Thank you,',
    business
  ].join('\n');
  const href = `mailto:${encodeURIComponent(job.email.trim())}`
    + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  // Use a transient anchor so the mail client opens without navigating the app away.
  const a = document.createElement('a');
  a.href = href;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


// Manually re-open the booking email for a scheduled job (wired to a detail-page button).
function resendBookingEmail(id) {
  const job = findJob(id);
  if (!job || !job.scheduled) return;
  if (!job.email || !job.email.trim()) {
    alert('No email address on file for this customer. Collect it to send a booking confirmation.');
    return;
  }
  sendBookingEmail(job);
}


// The customer replied "No": return the job to Requests, flag it so its card shows a
// yellow background, and note on the detail page that the electrician should contact the
// client for a new time. (In a browser-only app replies cannot be detected automatically,
// so this is triggered by the electrician after they see the reply.)
function customerDeclined(id) {
  const job = findJob(id);
  if (!job) return;
  if (!confirm('Mark this customer as declining the proposed time? The job moves back to Requests for you to reschedule.')) return;
  job.scheduled = false;
  job.scheduledStart = null;
  job.scheduledEnd = null;
  job.rescheduleRequested = true;
  job.beyondTarget = null;
  saveData();

  appState.currentScreen = 'overview';
  if (currentDetailId === job.id) {
    openDetail(job.id);
  } else {
    updateUI();
  }
}


// Clear the window and return the job to the Overview screen.
function unscheduleJob(id) {
  const job = findJob(id);
  if (!job) return;
  job.scheduled = false;
  job.scheduledStart = null;
  job.scheduledEnd = null;
  job.beyondTarget = null;
  saveData();

  appState.currentScreen = 'overview';
  if (currentDetailId === job.id) {
    openDetail(job.id);
  } else {
    updateUI();
  }
}


// ---------- Formatting helpers ----------

// Format a Date as the value a datetime-local input expects (local time, no timezone).
function toDatetimeLocalValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


// Locale fixed to English so weekday and month names never follow the browser/OS locale.
const DATE_LOCALE = 'en-US';


// "Jun 22, 2:30 PM" style display for a request's submitted date.
function formatRequestedDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}


// "Mon, Jun 23, 9:00 AM to 11:30 AM" style summary for a scheduled window.
function formatWindowSummary(startIso, endIso) {
  if (!startIso || !endIso) return 'Not scheduled';
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = start.toLocaleDateString(DATE_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  const startTime = start.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${startTime} to ${endTime}`;
}


// "2h30min" style duration for a scheduled window.
function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const hrs = (new Date(endIso) - new Date(startIso)) / 3600000;
  return formatHoursMinutes(hrs);
}


// "9:00 AM to 11:30 AM" style time range for the Scheduled screen's table column.
function formatWindowTimeRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const start = new Date(startIso);
  const end = new Date(endIso);
  const startTime = start.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString(DATE_LOCALE, { hour: 'numeric', minute: '2-digit' });
  return `${startTime} to ${endTime}`;
}


// Convert a fractional-hour number into "#h#min" form (e.g. 4.5 becomes "4h30min", 8 becomes "8h").
function formatHoursMinutes(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}min`;
}


// "Mon, Jun 23: 3 jobs, 6h30min / 8h30min" style header for a day's group of scheduled jobs.
function formatDayHeader(date, jobCount) {
  const dayLabel = date.toLocaleDateString(DATE_LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  const usedHours = dayScheduledMinutes(date) / 60;
  const capHours = appState.settings.dailyCapHours;
  return `${dayLabel}: ${jobCount} job${jobCount > 1 ? 's' : ''}, ${formatHoursMinutes(usedHours)} / ${formatHoursMinutes(capHours)}`;
}


// Build a Google Maps multi-stop directions URL for a day's jobs, in start-time order.
// This "universal" URL format opens the user's installed maps app (or prompts a choice)
// on Android and iOS, and falls back to Google Maps in the browser elsewhere. The base
// address is used as the route's starting point when one is set; the maps app itself
// lets the user change the start once the route opens.
function buildDayMapUrl(jobs) {
  const stops = jobs.filter(j => j.address && j.address.trim()).map(j => j.address.trim());
  if (stops.length === 0) return null;

  const params = new URLSearchParams();
  params.set('api', '1');
  params.set('travelmode', 'driving');

  const baseAddress = appState.settings.baseAddress;
  if (baseAddress) params.set('origin', baseAddress);

  const destination = stops[stops.length - 1];
  params.set('destination', destination);

  const waypoints = stops.slice(0, -1);
  if (waypoints.length > 0) params.set('waypoints', waypoints.join('|'));

  return 'https://www.google.com/maps/dir/?' + params.toString();
}


// ============ GEOGRAPHY ============
function estimateCoordinates(address) {
  if (!address) return null;

  // Simple city-based estimation for demo
  const cityCoords = {
    'carmel': { lat: 39.9784, lng: -86.1180 },
    'westfield': { lat: 40.0428, lng: -86.1275 },
    'fishers': { lat: 39.9568, lng: -85.9686 },
    'noblesville': { lat: 40.0456, lng: -86.0086 },
    'cicero': { lat: 40.1245, lng: -86.0140 },
    'sheridan': { lat: 40.1320, lng: -86.2210 },
    'arcadia': { lat: 40.1760, lng: -86.0230 }
  };

  const lower = address.toLowerCase();
  for (const [city, coords] of Object.entries(cityCoords)) {
    if (lower.includes(city)) return coords;
  }

  return { lat: 40.0, lng: -86.1 }; // Default central Indiana
}


// Great-circle (haversine) distance in miles between two {lat,lng} points. The base for
// all the app's distance/ETA estimates (road distance is approximated as a factor on top).
function straightLineMiles(a, b) {
  if (!a || !b) return 0;
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}


// Estimate road distance and drive time from the base to a job's point: straight-line
// miles scaled by 1.3 for roads, at an assumed 32 mph average, floored at 4 minutes.
function distanceAndEta(point) {
  if (!point || !appState.settings.baseCoordinates) return null;
  const straight = straightLineMiles(appState.settings.baseCoordinates, point);
  const roadMiles = straight * 1.3;
  const minutes = Math.max(4, Math.round(roadMiles / 32 * 60));
  return { miles: roadMiles, minutes };
}


// ============ MODAL MANAGEMENT ============
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}


function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}


// ============ UTILITIES ============
function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}


// Made with Bob