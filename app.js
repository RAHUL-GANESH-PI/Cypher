'use strict';

/* =========================================================
   Cypher — local-only personal tracker
   Everything is stored in this browser's localStorage.
   Nothing is sent to any server.
   ========================================================= */

/* ---------- tiny storage helper ---------- */
const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

/* =========================================================
   AUTH — fingerprint / Face unlock only, no passcode
   ========================================================= */
const WEBAUTHN_CRED_KEY = 'cypher_webauthn_credential';
const SESSION_KEY = 'cypher_session_unlocked';
const LEGACY_AUTH_HASH_KEY = 'cypher_auth_hash'; // no longer used; cleared on next successful unlock

async function biometricAvailable() {
  if (!window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function registerBiometric() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Cypher' },
      user: { id: userId, name: 'cypher-user', displayName: 'Cypher' },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' }
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
      attestation: 'none'
    }
  });
  const idB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
  Store.set(WEBAUTHN_CRED_KEY, idB64);
}

async function loginWithBiometric() {
  const idB64 = Store.get(WEBAUTHN_CRED_KEY, null);
  if (!idB64) throw new Error('No biometric registered on this device.');
  const rawId = Uint8Array.from(atob(idB64), (c) => c.charCodeAt(0));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: rawId, type: 'public-key', transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000
    }
  });
  return !!assertion;
}

/* ---------- auth UI wiring ---------- */
const lockScreen = document.getElementById('lock-screen');
const appScreen = document.getElementById('app');
const setupView = document.getElementById('setup-view');
const loginView = document.getElementById('login-view');

async function initAuthScreen() {
  const hasBiometric = !!Store.get(WEBAUTHN_CRED_KEY, null);

  if (sessionStorage.getItem(SESSION_KEY) === '1' && hasBiometric) {
    enterApp();
    return;
  }

  if (!hasBiometric) {
    setupView.hidden = false;
    loginView.hidden = true;
    const bioAvailable = await biometricAvailable();
    document.getElementById('setup-biometric-btn').hidden = !bioAvailable;
    document.getElementById('setup-unsupported').hidden = bioAvailable;
  } else {
    setupView.hidden = true;
    loginView.hidden = false;
    const bioAvailable = await biometricAvailable();
    if (bioAvailable) {
      // Kick off the fingerprint/Face prompt right away — no extra tap needed.
      attemptBiometricAuth();
    } else {
      const errorEl = document.getElementById('login-error');
      errorEl.textContent = "Fingerprint/Face unlock isn't available right now on this device or browser.";
      errorEl.hidden = false;
    }
  }
}

async function attemptBiometricAuth() {
  const errorEl = document.getElementById('login-error');
  try {
    const ok = await loginWithBiometric();
    if (ok) {
      errorEl.hidden = true;
      localStorage.removeItem(LEGACY_AUTH_HASH_KEY);
      sessionStorage.setItem(SESSION_KEY, '1');
      enterApp();
    }
  } catch (err) {
    console.warn(err);
    errorEl.textContent = 'Fingerprint/Face unlock failed or was cancelled. Tap the button to try again.';
    errorEl.hidden = false;
  }
}

document.getElementById('setup-biometric-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('setup-error');
  errorEl.hidden = true;
  try {
    await registerBiometric();
    localStorage.removeItem(LEGACY_AUTH_HASH_KEY);
    sessionStorage.setItem(SESSION_KEY, '1');
    enterApp();
  } catch (err) {
    console.warn(err);
    errorEl.textContent = 'Fingerprint/Face setup failed or was cancelled. Tap the button to try again.';
    errorEl.hidden = false;
  }
});

document.getElementById('biometric-btn').addEventListener('click', () => {
  attemptBiometricAuth();
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  const sure = confirm(
    'Resetting will permanently erase ALL Cypher data on this device (to-dos, goals, finances, and your fingerprint setup) so you can start over. This cannot be undone. Continue?'
  );
  if (!sure) return;

  const errorEl = document.getElementById('login-error');
  try {
    const ok = await loginWithBiometric();
    if (!ok) return;
  } catch (err) {
    console.warn(err);
    errorEl.textContent = 'Fingerprint/Face check failed or was cancelled. Reset was not performed.';
    errorEl.hidden = false;
    return;
  }
  localStorage.clear();
  sessionStorage.clear();
  location.reload();
});

function enterApp() {
  lockScreen.hidden = true;
  appScreen.hidden = false;
  renderTodos();
  renderGoals();
  renderTxns();
  renderHoldings();
}

/* =========================================================
   QR SHARE (lock screen) — lets someone else scan this app's own
   link and open it on their phone. Generated fully on-device.
   ========================================================= */
document.getElementById('qr-share-btn').addEventListener('click', () => {
  const url = location.origin + location.pathname;
  const canvas = document.getElementById('qr-canvas');
  try {
    QR.renderToCanvas(canvas, url, { size: 220 });
    document.getElementById('qr-link-text').textContent = url;
    document.getElementById('qr-modal').hidden = false;
  } catch (err) {
    console.warn('QR generation failed:', err);
    alert("Couldn't generate a QR code for this link.");
  }
});

document.getElementById('qr-modal-close').addEventListener('click', () => {
  document.getElementById('qr-modal').hidden = true;
});

document.getElementById('qr-modal').addEventListener('click', (e) => {
  if (e.target.id === 'qr-modal') document.getElementById('qr-modal').hidden = true;
});

document.getElementById('qr-copy-btn').addEventListener('click', async () => {
  const btn = document.getElementById('qr-copy-btn');
  const url = document.getElementById('qr-link-text').textContent;
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied!';
  } catch {
    btn.textContent = 'Copy failed — select the text above';
  }
  setTimeout(() => {
    btn.textContent = original;
  }, 1800);
});

/* =========================================================
   TAB NAVIGATION
   ========================================================= */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.fsub-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('fsub-' + btn.dataset.fsub).classList.add('active');
  });
});

/* =========================================================
   TO-DO
   ========================================================= */
let todos = Store.get('cypher_todos', []);
let todoFilter = 'all';

function saveTodos() {
  Store.set('cypher_todos', todos);
  renderTodos();
}

// Todos belong to the calendar day they were created on ("date": YYYY-MM-DD,
// in the device's local time). The To-Do tab shows one day at a time — "today"
// by default, or any date picked via the calendar icon — and older days stay
// in storage so their history can always be viewed again.
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() {
  return localDateStr(new Date());
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}
function todoDateOf(t) {
  return t.date || localDateStr(new Date(t.createdAt));
}

let viewDate = todayStr();

function renderTodos() {
  const list = document.getElementById('todo-list');
  const empty = document.getElementById('todo-empty');
  list.innerHTML = '';

  const isToday = viewDate === todayStr();
  document.getElementById('todo-date-label').textContent = isToday ? 'Today' : formatDate(viewDate);
  document.getElementById('todo-today-btn').hidden = isToday;
  document.getElementById('copy-yesterday-btn').hidden = !isToday;
  document.getElementById('copy-yesterday-msg').hidden = true;
  document.getElementById('todo-date-picker').value = viewDate;

  const dayTodos = todos.filter((t) => todoDateOf(t) === viewDate);

  const filtered = dayTodos.filter((t) => {
    if (todoFilter === 'active') return !t.done;
    if (todoFilter === 'done') return t.done;
    return true;
  });

  empty.hidden = dayTodos.length !== 0;
  empty.textContent = isToday
    ? 'Nothing here yet for today — add a task above, or copy yesterday\'s list.'
    : 'No tasks were recorded for this date.';

  // Tasks display in the order they're stored (not by date added), so drag
  // reordering below sticks. The drag handle only shows under the "All"
  // filter, since that's the only view where its position is unambiguous.
  const canReorder = todoFilter === 'all';

  filtered.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'list-item' + (t.done ? ' done' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      ${canReorder ? `
      <button class="drag-handle" data-id="${t.id}" aria-label="Drag to reorder" title="Drag to reorder">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle>
          <circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle>
          <circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle>
        </svg>
      </button>` : ''}
      <input type="checkbox" ${t.done ? 'checked' : ''} data-id="${t.id}" class="todo-check">
      <span class="item-text">${escapeHtml(t.text)}</span>
      <button class="item-delete" data-id="${t.id}" title="Delete">🗑</button>
    `;
    list.appendChild(li);
  });
}

// Moves a task to an arbitrary position within its day's list (used by drag reordering).
function moveTodoToIndex(id, newPosInDay) {
  const dayIndices = todos
    .map((t, i) => ({ t, i }))
    .filter((x) => todoDateOf(x.t) === viewDate)
    .map((x) => x.i);

  const curPos = dayIndices.findIndex((i) => todos[i].id === id);
  if (curPos === -1) return;

  newPosInDay = Math.max(0, Math.min(dayIndices.length - 1, newPosInDay));
  if (newPosInDay === curPos) return;

  const [item] = todos.splice(dayIndices[curPos], 1);

  const remaining = todos
    .map((t, i) => ({ t, i }))
    .filter((x) => todoDateOf(x.t) === viewDate)
    .map((x) => x.i);

  const insertAt =
    newPosInDay >= remaining.length
      ? remaining.length
        ? remaining[remaining.length - 1] + 1
        : todos.length
      : remaining[newPosInDay];

  todos.splice(insertAt, 0, item);
  saveTodos();
}

/* ---------- drag-to-reorder (pointer events: works for touch, mouse, pen) ---------- */
let todoDrag = null;

document.getElementById('todo-list').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  e.preventDefault();

  const li = handle.closest('.list-item');
  const listEl = document.getElementById('todo-list');
  const siblingRects = Array.from(listEl.querySelectorAll('.list-item'))
    .filter((el) => el !== li)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });

  todoDrag = {
    id: handle.dataset.id,
    li,
    startY: e.clientY,
    startRect: li.getBoundingClientRect(),
    siblingRects
  };

  li.classList.add('dragging');
  listEl.classList.add('reordering');
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic/unsupported pointer — dragging still works via document listeners */
  }

  document.addEventListener('pointermove', onTodoDragMove);
  document.addEventListener('pointerup', onTodoDragEnd);
  document.addEventListener('pointercancel', onTodoDragEnd);
});

function onTodoDragMove(e) {
  if (!todoDrag) return;
  const dy = e.clientY - todoDrag.startY;
  todoDrag.li.style.transform = `translateY(${dy}px)`;
}

function onTodoDragEnd(e) {
  if (!todoDrag) return;
  const dy = e.clientY - todoDrag.startY;
  const draggedCenter = todoDrag.startRect.top + dy + todoDrag.startRect.height / 2;

  let newPos = 0;
  todoDrag.siblingRects.forEach((s) => {
    if (s.top + s.height / 2 < draggedCenter) newPos++;
  });

  todoDrag.li.classList.remove('dragging');
  todoDrag.li.style.transform = '';
  document.getElementById('todo-list').classList.remove('reordering');

  document.removeEventListener('pointermove', onTodoDragMove);
  document.removeEventListener('pointerup', onTodoDragEnd);
  document.removeEventListener('pointercancel', onTodoDragEnd);

  const id = todoDrag.id;
  todoDrag = null;
  moveTodoToIndex(id, newPos);
}

document.getElementById('todo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('todo-input');
  const text = input.value.trim();
  if (!text) return;
  todos.push({ id: uid(), text, done: false, date: viewDate, createdAt: Date.now() });
  input.value = '';
  saveTodos();
});

document.getElementById('calendar-btn').addEventListener('click', () => {
  const picker = document.getElementById('todo-date-picker');
  if (picker.showPicker) {
    try {
      picker.showPicker();
      return;
    } catch {
      /* fall through to focus */
    }
  }
  picker.focus();
});

document.getElementById('todo-date-picker').addEventListener('change', (e) => {
  if (!e.target.value) return;
  viewDate = e.target.value;
  renderTodos();
});

document.getElementById('todo-today-btn').addEventListener('click', () => {
  viewDate = todayStr();
  renderTodos();
});

document.getElementById('todo-list').addEventListener('click', (e) => {
  const checkId = e.target.matches('.todo-check') && e.target.dataset.id;
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  if (checkId) {
    const t = todos.find((x) => x.id === checkId);
    if (t) t.done = e.target.checked;
    saveTodos();
  } else if (delId) {
    todos = todos.filter((x) => x.id !== delId);
    saveTodos();
  }
});

document.getElementById('todo-filters').addEventListener('click', (e) => {
  if (!e.target.matches('.chip')) return;
  document.querySelectorAll('#todo-filters .chip').forEach((c) => c.classList.remove('active'));
  e.target.classList.add('active');
  todoFilter = e.target.dataset.filter;
  renderTodos();
});

document.getElementById('copy-yesterday-btn').addEventListener('click', () => {
  const msg = document.getElementById('copy-yesterday-msg');
  const today = todayStr();
  const yesterday = yesterdayStr();

  const yesterdaysTodos = todos.filter((t) => todoDateOf(t) === yesterday);
  const todaysTextsLower = new Set(
    todos.filter((t) => todoDateOf(t) === today).map((t) => t.text.trim().toLowerCase())
  );

  const toCopy = yesterdaysTodos.filter((t) => !todaysTextsLower.has(t.text.trim().toLowerCase()));

  if (yesterdaysTodos.length === 0) {
    msg.textContent = "No tasks found for yesterday.";
  } else if (toCopy.length === 0) {
    msg.textContent = "Yesterday's tasks are already on today's list.";
  } else {
    toCopy.forEach((t) => {
      todos.push({ id: uid(), text: t.text, done: false, date: today, createdAt: Date.now() });
    });
    msg.textContent = `Copied ${toCopy.length} task${toCopy.length === 1 ? '' : 's'} from yesterday — all set to Active.`;
    saveTodos();
  }
  msg.hidden = false;
});

/* =========================================================
   GOALS
   ========================================================= */
let goals = Store.get('cypher_goals', []);

function saveGoals() {
  Store.set('cypher_goals', goals);
  renderGoals();
}

function renderGoals() {
  const list = document.getElementById('goal-list');
  const empty = document.getElementById('goals-empty');
  list.innerHTML = '';
  empty.hidden = goals.length !== 0;

  goals
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((g) => {
      const card = document.createElement('div');
      card.className = 'item-card';
      const dateStr = g.targetDate ? `Target: ${formatDate(g.targetDate)}` : '';
      card.innerHTML = `
        <div class="item-card-head">
          <div>
            <div class="item-card-title">${escapeHtml(g.title)}</div>
            ${g.notes ? `<div class="item-card-notes">${escapeHtml(g.notes)}</div>` : ''}
          </div>
          <button class="item-delete" data-id="${g.id}" title="Delete">🗑</button>
        </div>
        ${dateStr ? `<div class="item-card-meta">${dateStr}</div>` : ''}
        <div class="progress-row">
          <div class="progress-track"><div class="progress-fill" style="width:${g.progress}%"></div></div>
        </div>
        <div class="progress-btns">
          <button class="step-btn" data-id="${g.id}" data-delta="-1" aria-label="Decrease 1%" ${g.progress <= 0 ? 'disabled' : ''}>−</button>
          <span class="step-pct">${g.progress}%</span>
          <button class="step-btn" data-id="${g.id}" data-delta="1" aria-label="Increase 1%" ${g.progress >= 100 ? 'disabled' : ''}>+</button>
          <button class="mark-done-btn" data-id="${g.id}" data-delta="done">Mark done</button>
        </div>
      `;
      list.appendChild(card);
    });
}

const goalForm = document.getElementById('goal-form');
const goalAddToggle = document.getElementById('goal-add-toggle');

function openGoalForm() {
  goalForm.hidden = false;
  goalAddToggle.classList.add('is-open');
  goalAddToggle.setAttribute('aria-label', 'Close');
  document.getElementById('goal-title').focus();
}

function closeGoalForm() {
  goalForm.hidden = true;
  goalForm.reset();
  goalAddToggle.classList.remove('is-open');
  goalAddToggle.setAttribute('aria-label', 'Add a goal');
}

goalAddToggle.addEventListener('click', () => {
  if (goalForm.hidden) openGoalForm();
  else closeGoalForm();
});

document.getElementById('goal-cancel').addEventListener('click', closeGoalForm);

goalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = document.getElementById('goal-title').value.trim();
  const notes = document.getElementById('goal-notes').value.trim();
  const targetDate = document.getElementById('goal-date').value;
  if (!title) return;
  goals.push({ id: uid(), title, notes, targetDate, progress: 0, createdAt: Date.now() });
  closeGoalForm();
  saveGoals();
});

document.getElementById('goal-list').addEventListener('click', (e) => {
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  if (delId) {
    goals = goals.filter((g) => g.id !== delId);
    saveGoals();
    return;
  }
  if (e.target.matches('[data-delta]')) {
    const id = e.target.dataset.id;
    const delta = e.target.dataset.delta;
    const g = goals.find((x) => x.id === id);
    if (!g) return;
    if (delta === 'done') {
      g.progress = 100;
    } else {
      g.progress = Math.max(0, Math.min(100, g.progress + parseInt(delta, 10)));
    }
    saveGoals();
  }
});

/* =========================================================
   FINANCE — transactions
   ========================================================= */
let txns = Store.get('cypher_finance_transactions', []);
const currency = '₹';
let txnFilter = 'all';

document.getElementById('txn-date').valueAsDate = new Date();

function saveTxns() {
  Store.set('cypher_finance_transactions', txns);
  renderTxns();
}

function fmtMoney(n) {
  const num = Number(n) || 0;
  return currency + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function inTxnFilter(dateStr) {
  if (txnFilter === 'all') return true;
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  if (txnFilter === 'today') return dateStr === todayStr();
  if (txnFilter === 'week') {
    const diffDays = Math.floor((now - d) / 86400000);
    return diffDays >= 0 && diffDays < 7;
  }
  if (txnFilter === 'month') {
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }
  return true;
}

// Category is a fixed dropdown for expenses, free text for income (no preset "income categories" exist).
function updateTxnCategoryField() {
  const isExpense = document.getElementById('txn-type').value === 'expense';
  document.getElementById('txn-category-select').hidden = !isExpense;
  document.getElementById('txn-category-text').hidden = isExpense;
  document.getElementById('txn-category-select').required = isExpense;
  document.getElementById('txn-category-text').required = !isExpense;
}
document.getElementById('txn-type').addEventListener('change', updateTxnCategoryField);
updateTxnCategoryField();

function renderTxns() {
  const list = document.getElementById('txn-list');
  const empty = document.getElementById('txn-empty');
  list.innerHTML = '';

  const filtered = txns.filter((t) => inTxnFilter(t.date));
  empty.hidden = filtered.length !== 0;

  let income = 0;
  let expense = 0;
  filtered.forEach((t) => {
    if (t.type === 'income') income += Number(t.amount);
    else expense += Number(t.amount);
  });

  setStatValue('sum-income', fmtMoney(income));
  setStatValue('sum-expense', fmtMoney(expense));
  setStatValue('sum-balance', fmtMoney(income - expense));

  filtered
    .slice()
    .sort((a, b) => (b.date > a.date ? 1 : -1) || b.createdAt - a.createdAt)
    .forEach((t) => {
      const li = document.createElement('li');
      li.className = 'list-item txn-row';
      li.innerHTML = `
        <span class="item-text">
          <span class="txn-category">${escapeHtml(t.category)}</span>
          <span class="txn-meta">${formatDate(t.date)}${t.note ? ' · ' + escapeHtml(t.note) : ''}</span>
        </span>
        <span class="txn-amount ${t.type}">${t.type === 'income' ? '+' : '−'}${fmtMoney(t.amount)}</span>
        <button class="item-delete" data-id="${t.id}" title="Delete">🗑</button>
      `;
      list.appendChild(li);
    });
}

document.getElementById('txn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = document.getElementById('txn-type').value;
  const amount = parseFloat(document.getElementById('txn-amount').value);
  const category =
    type === 'expense'
      ? document.getElementById('txn-category-select').value
      : document.getElementById('txn-category-text').value.trim();
  const date = document.getElementById('txn-date').value;
  const note = document.getElementById('txn-note').value.trim();
  if (!amount || amount < 0 || !category || !date) return;

  txns.push({ id: uid(), type, amount, category, date, note, createdAt: Date.now() });
  e.target.reset();
  document.getElementById('txn-date').valueAsDate = new Date();
  updateTxnCategoryField();
  saveTxns();
});

document.getElementById('txn-list').addEventListener('click', (e) => {
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  if (delId) {
    txns = txns.filter((t) => t.id !== delId);
    saveTxns();
  }
});

document.getElementById('txn-filters').addEventListener('click', (e) => {
  if (!e.target.matches('.chip')) return;
  document.querySelectorAll('#txn-filters .chip').forEach((c) => c.classList.remove('active'));
  e.target.classList.add('active');
  txnFilter = e.target.dataset.filter;
  renderTxns();
});

/* =========================================================
   FINANCE — portfolio
   ========================================================= */
let holdings = Store.get('cypher_finance_portfolio', []);

function saveHoldings() {
  Store.set('cypher_finance_portfolio', holdings);
  renderHoldings();
}

function renderHoldings() {
  const list = document.getElementById('holding-list');
  const empty = document.getElementById('holdings-empty');
  list.innerHTML = '';
  empty.hidden = holdings.length !== 0;

  let invested = 0;
  let current = 0;

  holdings.forEach((h) => {
    invested += h.qty * h.buyPrice;
    current += h.qty * h.currentPrice;
  });

  const gain = current - invested;
  const gainPct = invested > 0 ? (gain / invested) * 100 : 0;

  setStatValue('sum-invested', fmtMoney(invested));
  setStatValue('sum-current', fmtMoney(current));
  setStatValue('sum-gain', `${gain >= 0 ? '+' : ''}${fmtMoney(gain)} (${gain >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)`);
  document.getElementById('sum-gain').classList.toggle('gain-positive', gain >= 0);
  document.getElementById('sum-gain').classList.toggle('gain-negative', gain < 0);

  holdings
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((h) => {
      const value = h.qty * h.currentPrice;
      const cost = h.qty * h.buyPrice;
      const g = value - cost;
      const gPct = cost > 0 ? (g / cost) * 100 : 0;
      const updatedAt = h.updatedAt || h.createdAt;
      const isGold = h.type === 'Gold';
      const qtyLabel = isGold ? 'Grams' : 'Qty';
      const editQtyLabel = isGold ? 'Edit Grams' : 'Edit Units';
      const qtyPlaceholder = isGold ? 'New grams' : 'New quantity';

      const card = document.createElement('div');
      card.className = 'item-card';
      card.innerHTML = `
        <div class="item-card-head">
          <div>
            <div class="item-card-title">${escapeHtml(h.name)}</div>
            <div class="item-card-meta">${escapeHtml(h.type || 'Stock')} · Price updated ${formatDateTime(updatedAt)}</div>
          </div>
          <button class="item-delete" data-id="${h.id}" title="Delete">🗑</button>
        </div>
        <div class="holding-stats">
          <div>${qtyLabel}: <b>${h.qty}</b></div>
          <div>Buy price: <b>${fmtMoney(h.buyPrice)}</b></div>
          <div>Current price: <b>${fmtMoney(h.currentPrice)}</b></div>
          <div>Value: <b>${fmtMoney(value)}</b></div>
          <div class="${g >= 0 ? 'gain-positive' : 'gain-negative'}">
            Gain/Loss: <b>${g >= 0 ? '+' : ''}${fmtMoney(g)} (${g >= 0 ? '+' : ''}${gPct.toFixed(1)}%)</b>
          </div>
        </div>
        <div class="holding-actions">
          <button type="button" class="chip update-price-btn" data-id="${h.id}">Update Price</button>
          <button type="button" class="chip update-qty-btn" data-id="${h.id}">${editQtyLabel}</button>
        </div>
        <form class="update-price-form" data-id="${h.id}" hidden>
          <input type="number" class="update-price-input" min="0" step="0.01" placeholder="New current price" required>
          <button type="submit" class="btn primary small">Save</button>
          <button type="button" class="btn secondary small cancel-update-price" data-id="${h.id}">Cancel</button>
        </form>
        <form class="update-qty-form" data-id="${h.id}" hidden>
          <input type="number" class="update-qty-input" min="0" step="0.0001" placeholder="${qtyPlaceholder}" required>
          <button type="submit" class="btn primary small">Save</button>
          <button type="button" class="btn secondary small cancel-update-qty" data-id="${h.id}">Cancel</button>
        </form>
      `;
      list.appendChild(card);
    });
}

function updateHoldingQtyLabel() {
  const isGold = document.getElementById('holding-type').value === 'Gold';
  document.getElementById('holding-qty-label').textContent = isGold ? 'Grams' : 'Quantity';
  document.getElementById('holding-qty').placeholder = isGold ? '0 (grams)' : '0';
}
document.getElementById('holding-type').addEventListener('change', updateHoldingQtyLabel);
updateHoldingQtyLabel();

document.getElementById('holding-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('holding-name').value.trim();
  const type = document.getElementById('holding-type').value;
  const qty = parseFloat(document.getElementById('holding-qty').value);
  const buyPrice = parseFloat(document.getElementById('holding-buy').value);
  const currentPrice = parseFloat(document.getElementById('holding-current').value);
  if (!name || isNaN(qty) || isNaN(buyPrice) || isNaN(currentPrice)) return;

  const now = Date.now();
  holdings.push({ id: uid(), name, type, qty, buyPrice, currentPrice, createdAt: now, updatedAt: now });
  e.target.reset();
  updateHoldingQtyLabel();
  saveHoldings();
});

document.getElementById('holding-list').addEventListener('click', (e) => {
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  const updatePriceBtn = e.target.closest('.update-price-btn');
  const cancelPriceBtn = e.target.closest('.cancel-update-price');
  const updateQtyBtn = e.target.closest('.update-qty-btn');
  const cancelQtyBtn = e.target.closest('.cancel-update-qty');

  if (delId) {
    holdings = holdings.filter((h) => h.id !== delId);
    saveHoldings();
    return;
  }

  if (updatePriceBtn) {
    const card = updatePriceBtn.closest('.item-card');
    const form = card.querySelector('.update-price-form');
    const h = holdings.find((x) => x.id === updatePriceBtn.dataset.id);
    form.querySelector('.update-price-input').value = h ? h.currentPrice : '';
    form.hidden = false;
    form.querySelector('.update-price-input').focus();
    return;
  }
  if (cancelPriceBtn) {
    cancelPriceBtn.closest('.update-price-form').hidden = true;
    return;
  }

  if (updateQtyBtn) {
    const card = updateQtyBtn.closest('.item-card');
    const form = card.querySelector('.update-qty-form');
    const h = holdings.find((x) => x.id === updateQtyBtn.dataset.id);
    form.querySelector('.update-qty-input').value = h ? h.qty : '';
    form.hidden = false;
    form.querySelector('.update-qty-input').focus();
    return;
  }
  if (cancelQtyBtn) {
    cancelQtyBtn.closest('.update-qty-form').hidden = true;
  }
});

document.getElementById('holding-list').addEventListener('submit', (e) => {
  if (e.target.matches('.update-price-form')) {
    e.preventDefault();
    const id = e.target.dataset.id;
    const newPrice = parseFloat(e.target.querySelector('.update-price-input').value);
    if (isNaN(newPrice) || newPrice < 0) return;

    const h = holdings.find((x) => x.id === id);
    if (h) {
      h.currentPrice = newPrice;
      h.updatedAt = Date.now();
      saveHoldings();
    }
    return;
  }

  if (e.target.matches('.update-qty-form')) {
    e.preventDefault();
    const id = e.target.dataset.id;
    const newQty = parseFloat(e.target.querySelector('.update-qty-input').value);
    if (isNaN(newQty) || newQty < 0) return;

    const h = holdings.find((x) => x.id === id);
    if (h) {
      h.qty = newQty;
      saveHoldings();
    }
  }
});

/* =========================================================
   DATA — export / import (.xlsx), for moving to another device
   ========================================================= */
const DATA_SHEETS = [
  { name: 'To-Do', key: 'cypher_todos', headers: ['ID', 'Date', 'Task', 'Done', 'Created At'] },
  { name: 'Goals', key: 'cypher_goals', headers: ['ID', 'Title', 'Notes', 'Target Date', 'Progress', 'Created At'] },
  { name: 'Transactions', key: 'cypher_finance_transactions', headers: ['ID', 'Type', 'Category', 'Amount', 'Date', 'Note', 'Created At'] },
  { name: 'Portfolio', key: 'cypher_finance_portfolio', headers: ['ID', 'Name', 'Type', 'Quantity', 'Buy Price', 'Current Price', 'Created At', 'Price Updated At'] }
];

function itemToRow(sheetName, item) {
  switch (sheetName) {
    case 'To-Do':
      return [item.id, item.date || '', item.text, item.done ? 'TRUE' : 'FALSE', item.createdAt];
    case 'Goals':
      return [item.id, item.title, item.notes || '', item.targetDate || '', item.progress, item.createdAt];
    case 'Transactions':
      return [item.id, item.type, item.category, item.amount, item.date, item.note || '', item.createdAt];
    case 'Portfolio':
      return [item.id, item.name, item.type || 'Stock', item.qty, item.buyPrice, item.currentPrice, item.createdAt, item.updatedAt || item.createdAt];
    default:
      return [];
  }
}

function rowToItem(sheetName, row) {
  switch (sheetName) {
    case 'To-Do':
      return { id: String(row[0]), date: String(row[1] || ''), text: String(row[2] || ''), done: String(row[3]).toUpperCase() === 'TRUE', createdAt: Number(row[4]) || Date.now() };
    case 'Goals':
      return { id: String(row[0]), title: String(row[1] || ''), notes: String(row[2] || ''), targetDate: String(row[3] || ''), progress: Number(row[4]) || 0, createdAt: Number(row[5]) || Date.now() };
    case 'Transactions':
      return { id: String(row[0]), type: String(row[1]), category: String(row[2] || ''), amount: Number(row[3]) || 0, date: String(row[4] || ''), note: String(row[5] || ''), createdAt: Number(row[6]) || Date.now() };
    case 'Portfolio': {
      const createdAt = Number(row[6]) || Date.now();
      return { id: String(row[0]), name: String(row[1] || ''), type: String(row[2] || 'Stock'), qty: Number(row[3]) || 0, buyPrice: Number(row[4]) || 0, currentPrice: Number(row[5]) || 0, createdAt, updatedAt: Number(row[7]) || createdAt };
    }
    default:
      return null;
  }
}

function buildExportSheets() {
  return DATA_SHEETS.map((s) => {
    const items = Store.get(s.key, []);
    const rows = [s.headers, ...items.map((item) => itemToRow(s.name, item))];
    return { name: s.name, rows };
  });
}

document.getElementById('data-btn').addEventListener('click', () => {
  document.getElementById('data-error').hidden = true;
  document.getElementById('data-msg').hidden = true;
  document.getElementById('data-modal').hidden = false;
});
document.getElementById('data-modal-close').addEventListener('click', () => {
  document.getElementById('data-modal').hidden = true;
});
document.getElementById('data-modal').addEventListener('click', (e) => {
  if (e.target.id === 'data-modal') document.getElementById('data-modal').hidden = true;
});

document.getElementById('export-btn').addEventListener('click', () => {
  try {
    const sheets = buildExportSheets();
    const blob = Xlsx.buildWorkbook(sheets);
    const stamp = todayStr();
    Xlsx.download(blob, `Cypher-backup-${stamp}.xlsx`);
    const msg = document.getElementById('data-msg');
    msg.textContent = 'Export started — check your downloads.';
    msg.hidden = false;
    document.getElementById('data-error').hidden = true;
  } catch (err) {
    console.warn('Export failed:', err);
    const errEl = document.getElementById('data-error');
    errEl.textContent = 'Export failed. Please try again.';
    errEl.hidden = false;
  }
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file later
  if (!file) return;

  const errEl = document.getElementById('data-error');
  const msgEl = document.getElementById('data-msg');
  errEl.hidden = true;
  msgEl.hidden = true;

  try {
    const buffer = await file.arrayBuffer();
    const parsed = Xlsx.parseWorkbook(buffer);

    const missing = DATA_SHEETS.filter((s) => !parsed[s.name]);
    if (missing.length) {
      throw new Error("This doesn't look like a Cypher export file.");
    }

    const sure = confirm(
      'Importing will replace all current To-Do, Goals, Transaction, and Portfolio data on this device with the contents of this file. This cannot be undone. Continue?'
    );
    if (!sure) return;

    DATA_SHEETS.forEach((s) => {
      const rows = parsed[s.name].slice(1); // drop header row
      const items = rows.filter((r) => r.length && r[0] !== '').map((r) => rowToItem(s.name, r));
      Store.set(s.key, items);
    });

    location.reload();
  } catch (err) {
    console.warn('Import failed:', err);
    errEl.textContent = err.message || 'Could not read that file. Make sure it\'s a .xlsx file exported from Cypher.';
    errEl.hidden = false;
  }
});

/* =========================================================
   UTILITIES
   ========================================================= */

// Sets a summary-card number and shrinks its font as the text gets longer,
// so large values (7+ digit portfolio totals, etc.) stay on one line instead
// of wrapping mid-number.
function setStatValue(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.toggle('stat-compact', text.length > 11 && text.length <= 15);
  el.classList.toggle('stat-tiny', text.length > 15 && text.length <= 19);
  el.classList.toggle('stat-xtiny', text.length > 19);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d)) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return isToday ? `today, ${time}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/* =========================================================
   PWA service worker
   ========================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

/* ---------- boot ---------- */
initAuthScreen();
