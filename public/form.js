'use strict';

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

let tokenWorks = false;

function showTokenStatus(works, text) {
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
    const result = await api('/api/token');
    showTokenStatus(true, 'Confluence token found in .env · ' + result.message);
  } catch (err) {
    showTokenStatus(false, err.message);
  }
}

$('token-recheck').addEventListener('click', checkToken);
checkToken();

const appSelect = $('app'), fromSelect = $('tagfrom'), toSelect = $('tagto');

function fillSelect(select, values, placeholder) {
  select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));
}

async function loadApps() {
  try {
    const { apps } = await api('/api/apps');
    fillSelect(appSelect, apps, apps.length ? '— Select app —' : 'No apps found');
  } catch (err) {
    fillSelect(appSelect, [], 'Could not load apps');
    showError('app', err.notConnected ? 'Could not load the apps: the page isn\'t connected to the release server (see above).' : err.message);
  }
}

async function loadTags(app) {
  for (const select of [fromSelect, toSelect]) {
    select.disabled = true;
    fillSelect(select, [], app ? 'Loading tags…' : 'Select an app first');
  }
  if (!app) return;
  try {
    const { tags } = await api(`/api/tags?app=${encodeURIComponent(app)}`);
    if (!tags.length) return showError('app', `No ${app}-<n>-OLD / -NEW tags found`);
    showValid('app');
    const olds = tags.filter(tag => tag.endsWith('-OLD'));
    const news = tags.filter(tag => tag.endsWith('-NEW'));
    fillSelect(fromSelect, olds, '— Select —');
    fillSelect(toSelect, news, '— Select —');
    fromSelect.value = olds[0] || '';
    toSelect.value = news[0] || '';
    fromSelect.disabled = toSelect.disabled = false;
  } catch (err) {
    showError('app', err.message);
  }
}

appSelect.addEventListener('change', () => loadTags(appSelect.value));
loadApps();

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
  if (!tokenWorks) {
    $('token-status').classList.add('shake');
    setTimeout(() => $('token-status').classList.remove('shake'), 450);
    ok = false;
  }
  return ok;
}

$('mainForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!checkAll()) return;

  const release = {
    app: appSelect.value,
    version: $('version').value.trim(),
    date: $('eventdate').value.trim(),
    from: fromSelect.value,
    to: toSelect.value,
  };
  const button = $('submitBtn'), status = $('statusMsg');
  button.disabled = true;
  button.classList.add('loading');
  status.textContent = 'Creating the release page…';
  status.className = 'status-msg';

  try {
    const { pageUrl, pullRequestCount } = await api('/api/release', release);
    const link = Object.assign(document.createElement('a'), {
      href: pageUrl, target: '_blank', rel: 'noopener', textContent: 'open in Confluence',
    });
    status.replaceChildren(`Release page created with ${pullRequestCount} PRs — `, link);
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('err');
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
});
