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
   AUTH
   ========================================================= */
const AUTH_HASH_KEY = 'cypher_auth_hash';
const WEBAUTHN_CRED_KEY = 'cypher_webauthn_credential';
const SESSION_KEY = 'cypher_session_unlocked';

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setPassword(password) {
  const salt = randomHex(16);
  const hash = await sha256Hex(salt + password);
  Store.set(AUTH_HASH_KEY, { salt, hash });
}

async function verifyPassword(password) {
  const stored = Store.get(AUTH_HASH_KEY, null);
  if (!stored) return false;
  const hash = await sha256Hex(stored.salt + password);
  return hash === stored.hash;
}

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
  const hasPassword = !!Store.get(AUTH_HASH_KEY, null);
  if (sessionStorage.getItem(SESSION_KEY) === '1' && hasPassword) {
    enterApp();
    return;
  }

  if (!hasPassword) {
    setupView.hidden = false;
    loginView.hidden = true;
    const bioAvailable = await biometricAvailable();
    document.getElementById('setup-biometric-row').hidden = !bioAvailable;
  } else {
    setupView.hidden = true;
    loginView.hidden = false;
    const hasBiometric = !!Store.get(WEBAUTHN_CRED_KEY, null);
    const bioAvailable = hasBiometric && (await biometricAvailable());
    document.getElementById('biometric-btn').hidden = !bioAvailable;
    if (bioAvailable) {
      // Kick off the fingerprint/Face prompt right away — no extra tap needed.
      // If it fails or is cancelled, the passcode field and the button both
      // stay available so the user can retry or fall back to typing.
      attemptBiometricAuth();
    }
  }
}

async function attemptBiometricAuth() {
  const errorEl = document.getElementById('login-error');
  try {
    const ok = await loginWithBiometric();
    if (ok) {
      errorEl.hidden = true;
      sessionStorage.setItem(SESSION_KEY, '1');
      enterApp();
    }
  } catch (err) {
    console.warn(err);
    errorEl.textContent = 'Biometric unlock failed or was cancelled. Use your passcode, or tap the button to try again.';
    errorEl.hidden = false;
  }
}

document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;
  const errorEl = document.getElementById('setup-error');
  errorEl.hidden = true;

  if (pw.length < 4) {
    errorEl.textContent = 'Passcode must be at least 4 characters.';
    errorEl.hidden = false;
    return;
  }
  if (pw !== confirm) {
    errorEl.textContent = 'Passcodes do not match.';
    errorEl.hidden = false;
    return;
  }

  await setPassword(pw);

  const wantsBiometric = document.getElementById('setup-biometric').checked;
  const bioRowVisible = !document.getElementById('setup-biometric-row').hidden;
  if (wantsBiometric && bioRowVisible) {
    try {
      await registerBiometric();
    } catch (err) {
      console.warn('Biometric enrollment skipped:', err);
    }
  }

  sessionStorage.setItem(SESSION_KEY, '1');
  enterApp();
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const ok = await verifyPassword(pw);
  if (ok) {
    errorEl.hidden = true;
    sessionStorage.setItem(SESSION_KEY, '1');
    document.getElementById('login-password').value = '';
    enterApp();
  } else {
    errorEl.textContent = 'Incorrect passcode. Try again.';
    errorEl.hidden = false;
  }
});

document.getElementById('biometric-btn').addEventListener('click', () => {
  attemptBiometricAuth();
});

document.getElementById('forgot-btn').addEventListener('click', () => {
  const sure = confirm(
    'Resetting will permanently erase ALL Cypher data on this device (to-dos, goals, finances, passcode) so you can start over. This cannot be undone. Continue?'
  );
  if (!sure) return;
  localStorage.clear();
  sessionStorage.clear();
  location.reload();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
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

  // Tasks display in the order they're stored (not by date added), so manual
  // reordering below sticks. Reorder arrows only show under the "All" filter,
  // since that's the only view where their up/down movement is unambiguous.
  const canReorder = todoFilter === 'all';

  filtered.forEach((t) => {
    const dayIndex = dayTodos.indexOf(t);
    const isFirst = dayIndex === 0;
    const isLast = dayIndex === dayTodos.length - 1;

    const li = document.createElement('li');
    li.className = 'list-item' + (t.done ? ' done' : '');
    li.innerHTML = `
      ${canReorder ? `
      <div class="reorder-btns">
        <button class="reorder-btn" data-id="${t.id}" data-dir="up" ${isFirst ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="reorder-btn" data-id="${t.id}" data-dir="down" ${isLast ? 'disabled' : ''} aria-label="Move down">▼</button>
      </div>` : ''}
      <input type="checkbox" ${t.done ? 'checked' : ''} data-id="${t.id}" class="todo-check">
      <span class="item-text">${escapeHtml(t.text)}</span>
      <button class="item-delete" data-id="${t.id}" title="Delete">🗑</button>
    `;
    list.appendChild(li);
  });
}

function moveTodo(id, direction) {
  const dayIndices = todos
    .map((t, i) => ({ t, i }))
    .filter((x) => todoDateOf(x.t) === viewDate)
    .map((x) => x.i);

  const posInDay = dayIndices.findIndex((i) => todos[i].id === id);
  if (posInDay === -1) return;

  const swapPos = direction === 'up' ? posInDay - 1 : posInDay + 1;
  if (swapPos < 0 || swapPos >= dayIndices.length) return;

  const idxA = dayIndices[posInDay];
  const idxB = dayIndices[swapPos];
  [todos[idxA], todos[idxB]] = [todos[idxB], todos[idxA]];
  saveTodos();
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
  const reorderBtn = e.target.closest('.reorder-btn');
  if (checkId) {
    const t = todos.find((x) => x.id === checkId);
    if (t) t.done = e.target.checked;
    saveTodos();
  } else if (delId) {
    todos = todos.filter((x) => x.id !== delId);
    saveTodos();
  } else if (reorderBtn) {
    moveTodo(reorderBtn.dataset.id, reorderBtn.dataset.dir);
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
let currency = Store.get('cypher_currency', '₹');

document.getElementById('currency-select').value = currency;
document.getElementById('currency-select').addEventListener('change', (e) => {
  currency = e.target.value;
  Store.set('cypher_currency', currency);
  renderTxns();
  renderHoldings();
});

document.getElementById('txn-date').valueAsDate = new Date();

function saveTxns() {
  Store.set('cypher_finance_transactions', txns);
  renderTxns();
}

function fmtMoney(n) {
  const num = Number(n) || 0;
  return currency + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTxns() {
  const list = document.getElementById('txn-list');
  const empty = document.getElementById('txn-empty');
  list.innerHTML = '';
  empty.hidden = txns.length !== 0;

  let income = 0;
  let expense = 0;
  txns.forEach((t) => {
    if (t.type === 'income') income += Number(t.amount);
    else expense += Number(t.amount);
  });

  document.getElementById('sum-income').textContent = fmtMoney(income);
  document.getElementById('sum-expense').textContent = fmtMoney(expense);
  document.getElementById('sum-balance').textContent = fmtMoney(income - expense);

  txns
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
  const category = document.getElementById('txn-category').value.trim();
  const date = document.getElementById('txn-date').value;
  const note = document.getElementById('txn-note').value.trim();
  if (!amount || amount < 0 || !category || !date) return;

  txns.push({ id: uid(), type, amount, category, date, note, createdAt: Date.now() });
  e.target.reset();
  document.getElementById('txn-date').valueAsDate = new Date();
  saveTxns();
});

document.getElementById('txn-list').addEventListener('click', (e) => {
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  if (delId) {
    txns = txns.filter((t) => t.id !== delId);
    saveTxns();
  }
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

  document.getElementById('sum-invested').textContent = fmtMoney(invested);
  document.getElementById('sum-current').textContent = fmtMoney(current);
  const gainEl = document.getElementById('sum-gain');
  gainEl.textContent = `${gain >= 0 ? '+' : ''}${fmtMoney(gain)} (${gain >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)`;
  gainEl.className = 'summary-value ' + (gain >= 0 ? 'gain-positive' : 'gain-negative');

  holdings
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach((h) => {
      const value = h.qty * h.currentPrice;
      const cost = h.qty * h.buyPrice;
      const g = value - cost;
      const gPct = cost > 0 ? (g / cost) * 100 : 0;
      const card = document.createElement('div');
      card.className = 'item-card';
      card.innerHTML = `
        <div class="item-card-head">
          <div class="item-card-title">${escapeHtml(h.name)}</div>
          <button class="item-delete" data-id="${h.id}" title="Delete">🗑</button>
        </div>
        <div class="holding-stats">
          <div>Qty: <b>${h.qty}</b></div>
          <div>Buy price: <b>${fmtMoney(h.buyPrice)}</b></div>
          <div>Current price: <b>${fmtMoney(h.currentPrice)}</b></div>
          <div>Value: <b>${fmtMoney(value)}</b></div>
          <div class="${g >= 0 ? 'gain-positive' : 'gain-negative'}">
            Gain/Loss: <b>${g >= 0 ? '+' : ''}${fmtMoney(g)} (${g >= 0 ? '+' : ''}${gPct.toFixed(1)}%)</b>
          </div>
        </div>
      `;
      list.appendChild(card);
    });
}

document.getElementById('holding-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('holding-name').value.trim();
  const qty = parseFloat(document.getElementById('holding-qty').value);
  const buyPrice = parseFloat(document.getElementById('holding-buy').value);
  const currentPrice = parseFloat(document.getElementById('holding-current').value);
  if (!name || isNaN(qty) || isNaN(buyPrice) || isNaN(currentPrice)) return;

  holdings.push({ id: uid(), name, qty, buyPrice, currentPrice, createdAt: Date.now() });
  e.target.reset();
  saveHoldings();
});

document.getElementById('holding-list').addEventListener('click', (e) => {
  const delId = e.target.matches('.item-delete') && e.target.dataset.id;
  if (delId) {
    holdings = holdings.filter((h) => h.id !== delId);
    saveHoldings();
  }
});

/* =========================================================
   UTILITIES
   ========================================================= */
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
