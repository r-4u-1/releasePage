'use strict';
// The release form: checks each field, loads apps and tags, and creates the release page.

// The element with this id. Pass the element type when it matters, e.g. $<HTMLInputElement>('version').
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// What to do when the page can't talk to the release server.
const START_SERVER = 'Start the server with "node server.ts" in the server folder, then open the address it prints (http://localhost:3000/).';

// An error from api(). notConnected is set when the page can't talk to the release server at all,
// so the fields can show a short note instead of repeating the whole message.
type ApiError = Error & { notConnected?: boolean };

function notConnectedError(message: string): ApiError {
  return Object.assign(new Error(message + ' ' + START_SERVER), { notConnected: true });
}

// What the release server answers. Every answer has "ok"; a failed one has a "message".
interface TokenAnswer { message: string }
interface FolderAnswer { folder: string }
interface AppsAnswer { apps: string[] }
interface TagsAnswer { tags: string[] }
interface ReleaseAnswer { pageUrl: string; pullRequestCount: number }

// What the form sends to POST /api/release.
interface ReleaseRequest { repo: string; app: string; version: string; date: string; from: string; to: string }

// Calls the release server. GET without a body, POST with one.
// Returns the JSON answer, or throws an Error with a message a person can act on.
async function api<Answer>(url: string, body?: object, signal?: AbortSignal): Promise<Answer> {
  const options: RequestInit = body === undefined ? { signal } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };

  if (location.protocol === 'file:') {
    throw notConnectedError('This page was opened as a file, so it can\'t reach the release server.');
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw notConnectedError(`Can't reach the release server at ${location.origin}: it isn't running.`);
  }

  // The release server always answers JSON with "ok". Anything else means this page was opened
  // from a different server, e.g. VS Code's Live Server, which doesn't know the release server's API.
  const data = await res.json().catch(() => null);
  if (!data || typeof data.ok !== 'boolean') {
    throw notConnectedError(`This page isn't connected to the release server: ${location.host} answered "${url}" with HTTP ${res.status}.`);
  }
  if (!data.ok) {
    throw new Error(data.message || `The release server answered HTTP ${res.status} without saying why. Its terminal may show more.`);
  }
  return data as Answer;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIELD STATES
   Plain fields: is-valid (green check) or has-error (red message).
═══════════════════════════════════════════════════════════════════════════ */

// A field with a value keeps its label floated above it.
function setFilled(input: HTMLInputElement | HTMLSelectElement) {
  input.closest('.field')?.classList.toggle('filled', input.value.trim() !== '');
}
document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(input => {
  input.addEventListener('input', () => setFilled(input));
  input.addEventListener('change', () => setFilled(input));
});

function showValid(id: string) {
  $('f-' + id).classList.remove('has-error');
  $('f-' + id).classList.add('is-valid');
  $('e-' + id).textContent = '';
}

function showError(id: string, message: string) {
  $('f-' + id).classList.remove('is-valid');
  $('f-' + id).classList.add('has-error');
  $('e-' + id).textContent = message;
}

function showNeutral(id: string) {
  $('f-' + id).classList.remove('has-error', 'is-valid');
  $('e-' + id).textContent = '';
}

/* ═══════════════════════════════════════════════════════════════════════════
   VERSION
═══════════════════════════════════════════════════════════════════════════ */
const versionInput = $<HTMLInputElement>('version');

function checkVersion() {
  const ok = versionInput.value.trim() !== '';
  if (ok) showValid('version');
  else showError('version', 'Version is required');
  return ok;
}

versionInput.addEventListener('blur', checkVersion);
versionInput.addEventListener('input', () => {
  if ($('f-version').classList.contains('has-error')) checkVersion();
});

/* ═══════════════════════════════════════════════════════════════════════════
   DATE — typed as YYYY-MM-DD (dashes added for you) or picked in the calendar
═══════════════════════════════════════════════════════════════════════════ */
const dateInput = $<HTMLInputElement>('eventdate');

(function dateField() {
  const input = dateInput, popup = $('cal-pop'), button = $('date-btn');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  let shown = { year: today.getFullYear(), month: today.getMonth() }; // month the calendar shows

  const isoDate = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
  function dayButton(year: number, month: number, day: number, otherMonth: boolean) {
    const date = new Date(year, month, day);
    const value = isoDate(date.getFullYear(), date.getMonth(), date.getDate());
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cal-day';
    button.textContent = String(date.getDate());
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

    const buttons: HTMLButtonElement[] = [];
    for (let i = leading - 1; i >= 0; i--) buttons.push(dayButton(year, month - 1, daysInPrevious - i, true));
    for (let d = 1; d <= daysInMonth; d++) buttons.push(dayButton(year, month, d, false));
    for (let d = 1; d <= trailing; d++) buttons.push(dayButton(year, month + 1, d, true));
    $('cal-days').replaceChildren(...buttons);
  }

  function showMonth(year: number, month: number) {
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

  const onClick = (id: string, action: (event: MouseEvent) => void) =>
    $(id).addEventListener('click', event => { event.preventDefault(); action(event); });
  onClick('date-btn', event => { event.stopPropagation(); popup.hidden ? openCalendar() : closeCalendar(); });
  onClick('cal-prev', () => showMonth(shown.year, shown.month - 1));
  onClick('cal-next', () => showMonth(shown.year, shown.month + 1));
  onClick('cal-lbl', () => showMonth(today.getFullYear(), today.getMonth()));
  onClick('cal-today', () => showMonth(today.getFullYear(), today.getMonth()));
  document.addEventListener('click', event => { if (!$('f-eventdate').contains(event.target as Node)) closeCalendar(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCalendar(); });
})();

/* ═══════════════════════════════════════════════════════════════════════════
   MONOREPO — the absolute path to it. Leaving the field asks the server whether it's a folder in a git repo.
   The repo's root (repo) is sent with every later request, and the browser remembers it for next time.
═══════════════════════════════════════════════════════════════════════════ */
const repoInput = $<HTMLInputElement>('repo');
let repo = '';

async function checkRepoFolder() {
  const folder = repoInput.value.trim();
  if (folder && folder === repo) return;
  repo = '';
  fillSelect(appSelect, [], 'Enter the monorepo path first');
  loadTags('');
  if (!folder) return showNeutral('repo');
  try {
    repo = (await api<FolderAnswer>('/api/folder?path=' + encodeURIComponent(folder))).folder;
    repoInput.value = repo; // e.g. C:\git\monorepo\web-app becomes C:\git\monorepo
    localStorage.setItem('repo', repo);
    showValid('repo');
    loadApps();
  } catch (err) {
    showError('repo', (err as ApiError).message);
  }
}

repoInput.addEventListener('blur', checkRepoFolder);

/* ═══════════════════════════════════════════════════════════════════════════
   TOKEN — read by the server from server/.env
   The page never sees the token. It only shows whether the server found one that works.
═══════════════════════════════════════════════════════════════════════════ */
let tokenWorks = false;

// Shows the token status line: a green dot when the token works, a red one with the reason when not.
function showTokenStatus(works: boolean, text: string) {
  tokenWorks = works;
  $('token-status').classList.remove('checking');
  $('token-status').classList.toggle('bad', !works);
  $('token-status-text').textContent = text;
  $('token-recheck').hidden = works;
}

async function checkToken() {
  $('token-status').classList.add('checking');
  $('token-status-text').textContent = 'Checking the Confluence token…';
  try {
    const result = await api<TokenAnswer>('/api/token');
    showTokenStatus(true, 'Confluence token found in .env · ' + result.message);
  } catch (err) {
    // e.g. "No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to C:\monorepo\release-page\server\.env"
    showTokenStatus(false, (err as ApiError).message);
  }
}

// After adding the token to .env, "Check again" picks it up. No restart needed.
$('token-recheck').addEventListener('click', checkToken);
checkToken();

/* ═══════════════════════════════════════════════════════════════════════════
   APP → TAGS
═══════════════════════════════════════════════════════════════════════════ */
const appSelect = $<HTMLSelectElement>('app'), fromSelect = $<HTMLSelectElement>('tagfrom'), toSelect = $<HTMLSelectElement>('tagto');

function fillSelect(select: HTMLSelectElement, values: string[], placeholder: string) {
  select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
}

async function loadApps() {
  try {
    const { apps } = await api<AppsAnswer>(`/api/apps?repo=${encodeURIComponent(repo)}`);
    fillSelect(appSelect, apps, apps.length ? '— Select app —' : 'No apps found');
  } catch (err) {
    const error = err as ApiError;
    fillSelect(appSelect, [], 'Could not load apps');
    // The token line above already explains a missing connection in full.
    showError('app', error.notConnected ? 'Could not load the apps: the page isn\'t connected to the release server (see above).' : error.message);
  }
}

async function loadTags(app: string) {
  for (const select of [fromSelect, toSelect]) {
    select.disabled = true;
    fillSelect(select, [], app ? 'Loading tags…' : 'Select an app first');
  }
  if (!app) return;
  try {
    const { tags } = await api<TagsAnswer>(`/api/tags?repo=${encodeURIComponent(repo)}&app=${encodeURIComponent(app)}`);
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
  } catch (err) {
    showError('app', (err as ApiError).message);
  }
}

appSelect.addEventListener('change', () => loadTags(appSelect.value));

// The monorepo path from last time, checked again. The apps load once it checks out.
repoInput.value = localStorage.getItem('repo') ?? '';
setFilled(repoInput);
checkRepoFolder();

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE PAGE — the server creates the Confluence page from these values
═══════════════════════════════════════════════════════════════════════════ */

// Marks every missing or unchecked field. True when everything is ready.
function checkAll() {
  let ok = checkVersion();
  if (!repo) {
    if (!repoInput.value.trim()) showError('repo', 'Enter the absolute path to the monorepo');
    ok = false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value.trim())) {
    showError('eventdate', 'Date is required (YYYY-MM-DD)');
    ok = false;
  }
  const selects: [HTMLSelectElement, string][] = [
    [appSelect, 'Select an app'], [fromSelect, 'Select the OLD tag'], [toSelect, 'Select the NEW tag'],
  ];
  for (const [select, message] of selects) {
    if (!select.value) { showError(select.id, message); ok = false; }
  }
  if (!tokenWorks) {
    $('token-status').classList.add('shake');
    setTimeout(() => $('token-status').classList.remove('shake'), 450);
    ok = false;
  }
  return ok;
}

$<HTMLFormElement>('mainForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!checkAll()) return;

  const release: ReleaseRequest = {
    repo,
    app: appSelect.value,
    version: versionInput.value.trim(),
    date: dateInput.value.trim(),
    from: fromSelect.value,
    to: toSelect.value,
  };
  const button = $<HTMLButtonElement>('submitBtn'), status = $('statusMsg');
  button.disabled = true;
  button.classList.add('loading');
  status.textContent = 'Creating the release page…';
  status.className = 'status-msg';

  try {
    // The server also opens the new page in the browser; this link is in case that didn't work.
    const { pageUrl, pullRequestCount } = await api<ReleaseAnswer>('/api/release', release);
    const link = Object.assign(document.createElement('a'), {
      href: pageUrl, target: '_blank', rel: 'noopener', textContent: 'open in Confluence',
    });
    status.replaceChildren(`Release page created with ${pullRequestCount} PRs — `, link);
    status.classList.add('ok');
  } catch (err) {
    status.textContent = (err as ApiError).message;
    status.classList.add('err');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
});
