'use strict';
// The release form: loads apps and tags, and creates the release page.

const getById = id => document.getElementById(id);

// Calls the release server. GET without a body, POST with one.
// Returns the JSON answer, or throws an Error with the server's message.
async function api(url, body) {
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const data = await (await fetch(url, options)).json();
  if (!data.ok) throw new Error(data.message);
  return data;
}

function fillSelect(select, values, placeholder) {
  select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
}

/* ═══ MONOREPO — leaving the field asks the server for the repo's root; the browser remembers it ═══ */
const repoInput = getById('repo'), appSelect = getById('app'), fromSelect = getById('tagfrom'), toSelect = getById('tagto');
let repo = '';

async function checkRepoFolder() {
  getById('e-repo').textContent = '';
  repo = '';
  fillSelect(appSelect, [], 'Enter the monorepo path first');
  if (!repoInput.value.trim()) return;
  try {
    repo = (await api('/api/folder?path=' + encodeURIComponent(repoInput.value.trim()))).folder;
    repoInput.value = repo;
    localStorage.setItem('repo', repo);
    loadApps();
  } catch (err) {
    getById('e-repo').textContent = err.message;
  }
}

repoInput.addEventListener('change', checkRepoFolder);

/* ═══ APP → TAGS ═══ */
async function loadApps() {
  const { apps } = await api(`/api/apps?repo=${encodeURIComponent(repo)}`);
  fillSelect(appSelect, apps, apps.length ? '— Select app —' : 'No apps found');
}

async function loadTags(app) {
  getById('e-app').textContent = '';
  fillSelect(fromSelect, [], 'Select an app first');
  fillSelect(toSelect, [], 'Select an app first');
  if (!app) return;
  try {
    const { tags } = await api(`/api/tags?repo=${encodeURIComponent(repo)}&app=${encodeURIComponent(app)}`);
    // Tags come highest number first, so the newest OLD/NEW pair is picked by default.
    const olds = tags.filter(tag => tag.endsWith('-OLD'));
    const news = tags.filter(tag => tag.endsWith('-NEW'));
    fillSelect(fromSelect, olds, '— Select —');
    fillSelect(toSelect, news, '— Select —');
    fromSelect.value = olds[0] || '';
    toSelect.value = news[0] || '';
  } catch (err) {
    getById('e-app').textContent = err.message;
  }
}

appSelect.addEventListener('change', () => loadTags(appSelect.value));

// The monorepo path from last time.
repoInput.value = localStorage.getItem('repo') ?? '';
checkRepoFolder();

/* ═══ CREATE PAGE ═══ */
getById('mainForm').addEventListener('submit', async event => {
  event.preventDefault();
  const release = {
    repo,
    app: appSelect.value,
    version: getById('version').value.trim(),
    date: getById('eventdate').value,
    from: fromSelect.value,
    to: toSelect.value,
  };
  const status = getById('statusMsg');
  getById('submitBtn').disabled = true;
  status.className = 'status-msg';
  status.textContent = 'Creating the release page…';

  try {
    const { pageUrl, pullRequestCount } = await api('/api/release', release);
    status.innerHTML = `Release page created with ${pullRequestCount} PRs — <a href="${pageUrl}" target="_blank">open in Confluence</a>`;
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('err');
  } finally {
    getById('submitBtn').disabled = false;
  }
});
