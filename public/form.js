'use strict';
// The release form: checks each field, loads apps, tags and changes, and creates the page.

const $ = id => document.getElementById(id);

// Calls the server. GET without a body, POST with one.
// Returns the JSON answer, or throws an Error with the server's message.
async function api(url, body, signal) {
  const options = body === undefined ? { signal } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw Object.assign(new Error('Server unreachable'), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.message || 'HTTP ' + res.status);
  return data;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIELD STATES
   Plain fields: is-valid (green check) or has-error (red message).
   Server-checked fields (token, page ID): vf-ok or vf-fail, see checkedField().
═══════════════════════════════════════════════════════════════════════════ */

// A field with a value keeps its label floated above it.
function setFilled(input) {
  input.closest('.field')?.classList.toggle('filled', input.value.trim() !== '');
}
document.querySelectorAll('input, select').forEach(input => {
  input.addEventListener('input', () => setFilled(input));
  input.addEventListener('change', () => setFilled(input));
});

function showValid(id) {
  $('f-' + id).classList.remove('has-error');
  $('f-' + id).classList.add('is-valid');
  $('e-' + id).textContent = '';
}

function showError(id, message) {
  $('f-' + id).classList.remove('is-valid');
  $('f-' + id).classList.add('has-error');
  $('e-' + id).textContent = message;
}

function showNeutral(id) {
  $('f-' + id).classList.remove('has-error', 'is-valid');
  $('e-' + id).textContent = '';
}

/* ═══════════════════════════════════════════════════════════════════════════
   VERSION
═══════════════════════════════════════════════════════════════════════════ */
function checkVersion() {
  const ok = $('version').value.trim() !== '';
  if (ok) showValid('version');
  else showError('version', 'Version is required');
  return ok;
}

$('version').addEventListener('blur', checkVersion);
$('version').addEventListener('input', () => {
  if ($('f-version').classList.contains('has-error')) checkVersion();
});

/* ═══════════════════════════════════════════════════════════════════════════
   DATE — typed as YYYY-MM-DD (dashes added for you) or picked in the calendar
═══════════════════════════════════════════════════════════════════════════ */
(function dateField() {
  const input = $('eventdate'), popup = $('cal-pop'), button = $('date-btn');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  let shown = { year: today.getFullYear(), month: today.getMonth() }; // month the calendar shows

  const isoDate = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function checkDate() {
    const value = input.value.trim();
    if (!value) return showNeutral('eventdate');
    if (!ISO.test(value)) return showError('eventdate', 'Format must be YYYY-MM-DD');
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const real = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
    if (!real || y < 1900 || y > 2100) return showError('eventdate', 'Please enter a valid date');
    showValid('eventdate');
  }

  // Typing "20261014" becomes "2026-10-14".
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    const masked = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6)].filter(Boolean).join('-');
    if (input.value !== masked) {
      input.value = masked;
      input.setSelectionRange(masked.length, masked.length);
    }
    if (masked.length < 10) showNeutral('eventdate');
    else checkDate();
  });
  input.addEventListener('blur', () => { if (input.value.trim()) checkDate(); });

  // One day button. `month` may be -1 or 12: Date rolls it into the next or previous year.
  function dayButton(year, month, day, otherMonth) {
    const date = new Date(year, month, day);
    const value = isoDate(date.getFullYear(), date.getMonth(), date.getDate());
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cal-day';
    button.textContent = date.getDate();
    if (otherMonth) button.classList.add('dim');
    if (value === isoDate(today.getFullYear(), today.getMonth(), today.getDate())) button.classList.add('today');
    if (value === input.value.trim()) button.classList.add('sel');
    button.addEventListener('click', () => {
      input.value = value;
      setFilled(input);
      checkDate();
      closeCalendar();
      input.focus();
    });
    return button;
  }

  // Weeks start on Monday. Days from the months around fill the first and last week.
  function render() {
    const { year, month } = shown;
    $('cal-lbl').textContent = `${MONTHS[month]} ${year}`;
    const leading = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevious = new Date(year, month, 0).getDate();
    const trailing = (7 - (leading + daysInMonth) % 7) % 7;

    const buttons = [];
    for (let i = leading - 1; i >= 0; i--) buttons.push(dayButton(year, month - 1, daysInPrevious - i, true));
    for (let d = 1; d <= daysInMonth; d++) buttons.push(dayButton(year, month, d, false));
    for (let d = 1; d <= trailing; d++) buttons.push(dayButton(year, month + 1, d, true));
    $('cal-days').replaceChildren(...buttons);
  }

  function showMonth(year, month) {
    shown = { year: year + Math.floor(month / 12), month: (month + 12) % 12 };
    render();
  }

  function openCalendar() {
    if (ISO.test(input.value)) {
      const [y, m] = input.value.split('-').map(Number);
      shown = { year: y, month: m - 1 };
    } else {
      shown = { year: today.getFullYear(), month: today.getMonth() };
    }
    render();
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function closeCalendar() {
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  const onClick = (id, action) => $(id).addEventListener('click', event => { event.preventDefault(); action(event); });
  onClick('date-btn', event => { event.stopPropagation(); popup.hidden ? openCalendar() : closeCalendar(); });
  onClick('cal-prev', () => showMonth(shown.year, shown.month - 1));
  onClick('cal-next', () => showMonth(shown.year, shown.month + 1));
  onClick('cal-lbl', () => showMonth(today.getFullYear(), today.getMonth()));
  onClick('cal-today', () => showMonth(today.getFullYear(), today.getMonth()));
  document.addEventListener('click', event => { if (!$('f-eventdate').contains(event.target)) closeCalendar(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCalendar(); });
})();

/* ═══════════════════════════════════════════════════════════════════════════
   SERVER-CHECKED FIELDS
   Checked 600 ms after typing stops, and right away when the field is left.
   While checking: spinner. Then a green badge, or a red message with a shake.
═══════════════════════════════════════════════════════════════════════════ */

// request(value) returns { url, body } to send, or a message to show without asking the server.
function checkedField(id, request, onOk = () => {}) {
  const field = $('f-' + id), input = $(id), error = $('e-' + id);
  const badge = $('badge-' + id), spinner = $('spinner-' + id);
  let lastChecked = null, timer = null, controller = null;

  function reset() {
    field.classList.remove('vf-ok', 'vf-fail', 'vf-shake', 'has-error');
    error.textContent = '';
    spinner.classList.remove('active');
    badge.classList.remove('show');
    badge.classList.add('hide');
    setTimeout(() => badge.classList.remove('hide'), 200);
  }

  function pass() {
    spinner.classList.remove('active');
    field.classList.add('vf-ok');
    badge.classList.remove('hide');
    badge.classList.add('show');
  }

  function fail(message) {
    reset();
    field.classList.add('vf-fail');
    error.textContent = message;
    void field.offsetWidth; // restarts the shake animation
    field.classList.add('vf-shake');
    setTimeout(() => field.classList.remove('vf-shake'), 450);
  }

  async function check(value) {
    if (!value || value === lastChecked) return;
    controller?.abort();
    reset();
    const req = request(value);
    if (typeof req === 'string') {
      lastChecked = null;
      return fail(req);
    }
    lastChecked = value;
    controller = new AbortController();
    spinner.classList.add('active');
    try {
      const data = await api(req.url, req.body, controller.signal);
      pass();
      onOk(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (err.offline) lastChecked = null; // try again next time
      fail(err.message);
    }
  }

  input.addEventListener('blur', () => {
    clearTimeout(timer);
    check(input.value.trim());
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const value = input.value.trim();
    if (!value) {
      controller?.abort();
      reset();
      lastChecked = null;
      return;
    }
    timer = setTimeout(() => check(value), 600);
  });

  // Checks the current value again, e.g. after the token changed.
  return { recheck() { lastChecked = null; check(input.value.trim()); } };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARENT PAGE ID — needs a verified token first
═══════════════════════════════════════════════════════════════════════════ */
const savedParents = {};                     // app → parent page ID saved on the server
let checkedPage = { id: null, title: null }; // the last page the server confirmed

// The hint under the field, e.g. "“App A releases” · saved for app-a".
function updatePageHint() {
  const app = $('app').value, id = $('pageid').value.trim();
  const parts = [];
  if (checkedPage.id === id && $('f-pageid').classList.contains('vf-ok')) parts.push(`“${checkedPage.title}”`);
  if (app && id) {
    if (savedParents[app] === id) parts.push(`saved for ${app}`);
    else if (savedParents[app]) parts.push(`replaces the saved parent for ${app} after the page is created`);
    else parts.push(`will be saved for ${app} after the page is created`);
  }
  $('h-pageid').textContent = parts.join(' · ');
}

const pageField = checkedField('pageid', pageId => {
  updatePageHint();
  if (!$('f-token').classList.contains('vf-ok')) return 'Verify the token first';
  if (!/^\d+$/.test(pageId)) return 'Page ID must be a number';
  return { url: '/api/verify/page', body: { token: typedToken(), pageId } };
}, page => {
  checkedPage = { id: $('pageid').value.trim(), title: page.title };
  updatePageHint();
});

/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN — typed, or the one the server keeps in .env (never sent to the page)
═══════════════════════════════════════════════════════════════════════════ */
let usingSavedToken = false;
let tokenCanBeSaved = false;

// The token to send. Nothing when the server should use its saved one.
function typedToken() {
  return usingSavedToken ? undefined : $('token').value.trim();
}

function showTokenHint(text) {
  $('h-token').textContent = text;
}

function showDefaultTokenHint() {
  showTokenHint(tokenCanBeSaved ? 'Saved to .env once it is verified' : 'Create server/.env to remember the token');
}

// Swaps the token field for the "Using the token saved in .env" line, or back.
function showSavedToken(on, text) {
  usingSavedToken = on;
  $('token-saved').hidden = !on;
  $('f-token').hidden = on;
  if (text) $('token-saved-text').textContent = text;
  $('f-token').classList.toggle('vf-ok', on); // the page ID check looks at this
}

checkedField('token', token => ({ url: '/api/verify/token', body: { token } }), result => {
  showTokenHint(result.saved ? 'Saved to .env' : '');
  pageField.recheck(); // page access depends on the token
});

$('token-change').addEventListener('click', () => {
  showSavedToken(false);
  showDefaultTokenHint();
  $('token').value = '';
  setFilled($('token'));
  $('token').focus();
  pageField.recheck();
});

// On load: use the saved token if the server has one that works.
(async function useSavedToken() {
  try {
    const status = await api('/api/token');
    tokenCanBeSaved = status.canSave;
    showDefaultTokenHint();
    if (!status.saved) return;
    try {
      const result = await api('/api/verify/token', {});
      showSavedToken(true, 'Using the token saved in .env · ' + result.message);
      pageField.recheck();
    } catch (err) {
      showTokenHint(`The token in .env was rejected (${err.message}) — paste a new one`);
    }
  } catch {
    // Server unreachable: the token field stays as it is.
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   APP → TAGS → CHANGES
═══════════════════════════════════════════════════════════════════════════ */
const appSelect = $('app'), fromSelect = $('tagfrom'), toSelect = $('tagto');

function fillSelect(select, values, placeholder) {
  select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
}

async function loadApps() {
  try {
    const { apps } = await api('/api/apps');
    for (const app of apps) if (app.parentId) savedParents[app.name] = app.parentId;
    fillSelect(appSelect, apps.map(app => app.name), apps.length ? '— Select app —' : 'No apps found');
  } catch (err) {
    fillSelect(appSelect, [], 'Could not load apps');
    showError('app', err.message);
  }
}

async function loadTags(app) {
  hideChanges();
  for (const select of [fromSelect, toSelect]) {
    select.disabled = true;
    fillSelect(select, [], app ? 'Loading tags…' : 'Select an app first');
  }
  if (!app) return;
  try {
    const { tags } = await api(`/api/apps/${encodeURIComponent(app)}/tags`);
    if (!tags.length) return showError('app', `No ${app}-<n>-OLD / -NEW tags found`);
    showValid('app');
    // Tags come highest number first, so the newest OLD/NEW pair is picked by default.
    const olds = tags.filter(tag => tag.endsWith('-OLD'));
    const news = tags.filter(tag => tag.endsWith('-NEW'));
    fillSelect(fromSelect, olds, '— Select —');
    fillSelect(toSelect, news, '— Select —');
    fromSelect.value = olds[0] || '';
    toSelect.value = news[0] || '';
    fromSelect.disabled = toSelect.disabled = false;
    loadChanges();
  } catch (err) {
    showError('app', err.message);
  }
}

let changesRequest = 0; // answers to older selections are ignored

function hideChanges() {
  changesRequest++;
  $('changes').hidden = true;
  $('changes-body').replaceChildren();
}

function showChangesSummary(text, isError = false) {
  $('changes').hidden = false;
  $('changes-sum').textContent = text;
  $('changes-sum').classList.toggle('err', isError);
}

function changeRow(change) {
  const row = document.createElement('tr');
  row.insertCell().textContent = change.author;
  const pr = row.insertCell();
  pr.textContent = pr.title = change.title;
  if (change.pr) {
    const number = document.createElement('span');
    number.className = 'pr-num';
    number.textContent = '#' + change.pr;
    pr.append(number);
  }
  return row;
}

async function loadChanges() {
  const app = appSelect.value, from = fromSelect.value, to = toSelect.value;
  hideChanges();
  if (!app || !from || !to) return;
  const request = changesRequest;
  showChangesSummary('Reading git log…');
  try {
    const { changes } = await api(`/api/apps/${encodeURIComponent(app)}/changes?` + new URLSearchParams({ from, to }));
    if (request !== changesRequest) return;
    $('changes-body').replaceChildren(...changes.map(changeRow));
    const n = changes.length;
    showChangesSummary(n
      ? `${n} change${n === 1 ? '' : 's'} in ${app} between ${from} and ${to}`
      : `No changes in ${app} between ${from} and ${to}`);
  } catch (err) {
    if (request === changesRequest) showChangesSummary(err.message, true);
  }
}

// Picking an app fills in its saved parent page (it can still be changed) and loads its tags.
appSelect.addEventListener('change', () => {
  const app = appSelect.value;
  $('pageid').value = savedParents[app] || '';
  $('pageid').dispatchEvent(new Event('input')); // checks it like typing would
  updatePageHint();
  loadTags(app);
});
fromSelect.addEventListener('change', loadChanges);
toSelect.addEventListener('change', loadChanges);
loadApps();

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE PAGE
═══════════════════════════════════════════════════════════════════════════ */

// Marks every missing or unchecked field. True when everything is ready.
function checkAll() {
  let ok = checkVersion();
  if (!/^\d{4}-\d{2}-\d{2}$/.test($('eventdate').value.trim())) {
    showError('eventdate', 'Date is required (YYYY-MM-DD)');
    ok = false;
  }
  const selects = [['app', 'Select an app'], ['tagfrom', 'Select the OLD tag'], ['tagto', 'Select the NEW tag']];
  for (const [id, message] of selects) {
    if (!$(id).value) { showError(id, message); ok = false; }
  }
  const checked = [['token', 'Verify the token first'], ['pageid', 'Enter a parent page the token can reach']];
  for (const [id, message] of checked) {
    if ($('f-' + id).classList.contains('vf-ok')) continue;
    $('f-' + id).classList.add('vf-fail');
    $('e-' + id).textContent ||= message;
    ok = false;
  }
  return ok;
}

$('mainForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!checkAll()) return;

  const release = {
    token: typedToken(),
    app: appSelect.value,
    pageId: $('pageid').value.trim(),
    version: $('version').value.trim(),
    date: $('eventdate').value.trim(),
    from: fromSelect.value,
    to: toSelect.value,
  };
  const button = $('submitBtn'), status = $('statusMsg');
  button.disabled = true;
  button.classList.add('loading');
  status.textContent = '';
  status.className = 'status-msg';

  try {
    const page = await api('/api/release', release);
    savedParents[release.app] = release.pageId; // the server saved it too
    updatePageHint();
    const link = Object.assign(document.createElement('a'), {
      href: page.url, target: '_blank', rel: 'noopener', textContent: 'open in Confluence',
    });
    status.replaceChildren(`Created “${page.title}” — `, link);
    status.classList.add('ok');
  } catch (err) {
    status.textContent = 'Could not create the page — ' + err.message;
    status.classList.add('err');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
});
