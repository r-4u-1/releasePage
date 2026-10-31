// Release page creator: creates the Confluence release page for one app in the monorepo.
//
// Run:    node release-page.ts   then open http://localhost:3000/
// Needs:  Node.js 22.18+ and git. Nothing to install: Node runs this TypeScript as it is.
//
// Setup:
//   1. Put this file in its own folder of the monorepo, e.g. release-page/.
//   2. Fill in SETTINGS below:
//        confluenceUrl     Confluence's address, e.g. https://confluence.example.com (Cloud: https://<site>.atlassian.net/wiki)
//        confluenceEmail   empty for Data Center; for Cloud, the account email that owns the API token
//        apps              the monorepo's app folders, each with the ID of the Confluence page its release pages go under
//                          (the ID is in the page's address: …pageId=123456). verification: true adds the isVerified
//                          and Note columns and an info box with verificationInfo.
//   3. Create .env next to this file with the line  CONFLUENCE_TOKEN=<your token>
//      (Confluence: profile picture → Settings → Personal Access Tokens). Keep .env in .gitignore.
//
// What it does: you pick an app, two tags (<app>-<n>-OLD and <app>-<n>-NEW), a version and a date. The server reads
// the "Merged PR" commits between the two tags that changed the app's folder, creates the page "Rel of <app> - <date>"
// under the app's parent page with a table of them (author + PR title), and opens it in your browser.
// The token never reaches the page, and the server only answers http://localhost:3000/ on this computer.
//
// API: GET /api/token · GET /api/apps · GET /api/tags?app=… · POST /api/release { app, version, date, from, to }

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';

// ═════ SETTINGS ═════════════════════════════════════════════════════════════

const config = {
  port: 3000,
  confluenceUrl: 'https://confluence.example.com',
  confluenceEmail: '',
  apps: {
    'a-app': { parentPageId: '100001', verification: true },
    'b-app': { parentPageId: '100002', verification: true },
  } as Record<string, { parentPageId: string; verification?: boolean }>,
  verificationInfo: 'This app needs every PR verified before the release. Tick isVerified once a PR is tested, and add a Note if something needs attention.',
};

const PORT = Number(process.env.PORT) || config.port;
const ENV_FILE = path.join(import.meta.dirname, '.env');

// ═════ HELPERS ══════════════════════════════════════════════════════════════

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═════ GIT ══════════════════════════════════════════════════════════════════

interface PullRequest {
  author: string;
  title: string;
}

const git = (args: string[]) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' });

function listTags(app: string): string[] {
  const tagNumber = (tag: string) => Number(tag.split('-').at(-2));
  return git(['tag', '--list', `${app}-*-OLD`, `${app}-*-NEW`])
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => tagNumber(b) - tagNumber(a) || a.localeCompare(b));
}

function listMergedPullRequests(app: string, from: string, to: string): PullRequest[] {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const commits = git(['log', '--first-parent', '--grep=Merged PR', '--format=%P%x1f%an%x1f%s', `${from}..${to}`, '--', path.join(root, app)])
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\x1f'));

  const branchTips = commits.map(([parents]) => parents.split(' ')[1]).filter(Boolean);
  const authors: Record<string, string> = branchTips.length === 0 ? {} : Object.fromEntries(
    git(['show', '--no-patch', '--format=%H%x1f%an', ...branchTips]).split('\n').filter(Boolean).map(line => line.split('\x1f'))
  );

  return commits.map(([parents, mergedBy, subject]) => ({
    author: authors[parents.split(' ')[1]] || mergedBy,
    title: subject.replace(/^Merged PR \d+:\s*/, ''),
  }));
}

// ═════ CONFLUENCE ═══════════════════════════════════════════════════════════

function readToken(): string {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const token = /^\s*CONFLUENCE_TOKEN\s*=\s*['"]?(.*?)['"]?\s*$/m.exec(env)?.[1];
  return token || fail(400, `No Confluence token found. Add the line CONFLUENCE_TOKEN=<your token> to ${ENV_FILE}`);
}

async function confluence<Answer>(method: 'GET' | 'POST', apiPath: string, body?: object): Promise<Answer> {
  const token = readToken();
  const authorization = config.confluenceEmail
    ? 'Basic ' + Buffer.from(`${config.confluenceEmail}:${token}`).toString('base64')
    : 'Bearer ' + token;

  const response = await fetch(config.confluenceUrl + apiPath, {
    method,
    headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).catch(error => fail(502, `Can't reach Confluence at ${config.confluenceUrl} (${error.cause?.code ?? error.message}).`));

  const answer = await response.json().catch(() => ({}));
  if (response.status === 401) fail(401, `Confluence rejected the token in ${ENV_FILE}. It's wrong or expired.`);
  if (!response.ok) fail(response.status, `Confluence answered HTTP ${response.status}: ${answer.message ?? 'no reason given'}`);
  return answer;
}

// ═════ PAGE CONTENT ═════════════════════════════════════════════════════════

function releasePageContent(app: string, version: string, date: string, from: string, to: string, pullRequests: PullRequest[]): string {
  const verification = config.apps[app].verification;
  const headers = verification ? ['Author', 'Pull request', 'isVerified', 'Note'] : ['Author', 'Pull request'];
  const row = (pr: PullRequest) => `<tr><td>${escapeHtml(pr.author)}</td><td>${escapeHtml(pr.title)}</td>${verification ? '<td></td><td></td>' : ''}</tr>`;

  const summary = `<p><strong>Version:</strong> ${escapeHtml(version)} · <strong>Release date:</strong> ${escapeHtml(date)}`
    + ` · <strong>Tags:</strong> ${from} → ${to} · <strong>Pull requests:</strong> ${pullRequests.length}</p>`;
  const table = `<table><tbody><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr>${pullRequests.map(row).join('')}</tbody></table>`;
  if (!verification) return summary + table;

  return '<ac:layout><ac:layout-section ac:type="two_right_sidebar">'
    + `<ac:layout-cell>${summary}${table}</ac:layout-cell>`
    + '<ac:layout-cell><ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Verification</ac:parameter>'
    + `<ac:rich-text-body><p>${escapeHtml(config.verificationInfo)}</p></ac:rich-text-body></ac:structured-macro></ac:layout-cell>`
    + '</ac:layout-section></ac:layout>';
}

// ═════ API ══════════════════════════════════════════════════════════════════

async function createRelease({ app, version, date, from, to }: Record<string, string>) {
  if (!Object.hasOwn(config.apps, app)) fail(400, `Unknown app "${app}".`);
  const tags = listTags(app);
  if (!tags.includes(from) || !tags.includes(to)) fail(400, `Pick the tags of ${app} again.`);

  const pullRequests = listMergedPullRequests(app, from, to);
  if (pullRequests.length === 0) fail(400, `No merged PRs in ${app} between ${from} and ${to}.`);

  const { parentPageId } = config.apps[app];
  const parent = await confluence<{ space: { key: string } }>('GET', `/rest/api/content/${parentPageId}?expand=space`);
  const page = await confluence<{ _links: { base: string; webui: string } }>('POST', '/rest/api/content', {
    type: 'page',
    title: `Rel of ${app} - ${date}`,
    space: { key: parent.space.key },
    ancestors: [{ id: parentPageId }],
    body: { storage: { value: releasePageContent(app, version, date, from, to, pullRequests), representation: 'storage' } },
  });

  const pageUrl = page._links.base + page._links.webui;
  const [command, ...args] = process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler']
    : [process.platform === 'darwin' ? 'open' : 'xdg-open'];
  execFile(command, [...args, pageUrl], () => {});
  return { pageUrl, pullRequestCount: pullRequests.length };
}

const API: Record<string, (body: Record<string, string>, url: URL) => object | Promise<object>> = {
  'GET /api/token': async () => ({ message: `Authenticated as ${(await confluence<{ displayName: string }>('GET', '/rest/api/user/current')).displayName}` }),
  'GET /api/apps': () => ({ apps: Object.keys(config.apps) }),
  'GET /api/tags': (body, url) => ({ tags: listTags(url.searchParams.get('app') ?? '') }),
  'POST /api/release': body => createRelease(body),
};

// ═════ SERVER ═══════════════════════════════════════════════════════════════

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /') return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FORM_PAGE);

  const sendJson = (status: number, data: object) =>
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
  try {
    const { host = '', origin } = request.headers;
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(host) || (origin && origin !== `http://${host}`)) {
      fail(403, `Open the page as http://localhost:${PORT}/`);
    }
    if (!API[route]) fail(404, `The release server has no "${route}".`);

    let body = '';
    for await (const chunk of request) body += chunk;
    sendJson(200, { ok: true, ...await API[route](JSON.parse(body || '{}'), url) });
  } catch (error) {
    const { status = 500, message } = error as Error & { status?: number };
    sendJson(status, { ok: false, message });
  }
}

// ═════ THE FORM PAGE ════════════════════════════════════════════════════════

function formScript(): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const versionInput = $<HTMLInputElement>('version'), dateInput = $<HTMLInputElement>('eventdate');
  const appSelect = $<HTMLSelectElement>('app'), fromSelect = $<HTMLSelectElement>('tagfrom'), toSelect = $<HTMLSelectElement>('tagto');
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  let tokenWorks = false;

  async function api<Answer>(url: string, body?: object): Promise<Answer> {
    const response = await fetch(url, body && { method: 'POST', body: JSON.stringify(body) }).catch(() => {
      throw new Error('Can\'t reach the release server. Start it with "node release-page.ts".');
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.message);
    return data;
  }

  function mark(id: string, error = '') {
    $('f-' + id).classList.toggle('has-error', error !== '');
    $('f-' + id).classList.toggle('is-valid', error === '');
    $('e-' + id).textContent = error;
  }

  const setFilled = (input: HTMLInputElement | HTMLSelectElement) => input.closest('.field')?.classList.toggle('filled', input.value !== '');
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(input => {
    input.addEventListener('input', () => setFilled(input));
    input.addEventListener('change', () => setFilled(input));
  });

  versionInput.addEventListener('blur', () => mark('version', versionInput.value.trim() ? '' : 'Version is required'));

  dateInput.addEventListener('input', () => {
    const digits = dateInput.value.replace(/\D/g, '').slice(0, 8);
    const masked = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6)].filter(Boolean).join('-');
    if (dateInput.value !== masked) dateInput.value = masked;
    if (ISO.test(masked)) mark('eventdate');
  });

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let shown = today;

  function showMonth(year: number, month: number) {
    shown = new Date(year, month, 1);
    $('cal-lbl').textContent = `${MONTHS[shown.getMonth()]} ${shown.getFullYear()}`;
    const leading = (shown.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = Array.from({ length: Math.ceil((leading + daysInMonth) / 7) * 7 }, (_, i) => new Date(year, month, i + 1 - leading));
    $('cal-days').replaceChildren(...days.map(day => {
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'cal-day', textContent: String(day.getDate()) });
      button.classList.toggle('dim', day.getMonth() !== shown.getMonth());
      button.classList.toggle('today', iso(day) === iso(today));
      button.classList.toggle('sel', iso(day) === dateInput.value);
      button.addEventListener('click', () => {
        dateInput.value = iso(day);
        setFilled(dateInput);
        mark('eventdate');
        showCalendar(false);
      });
      return button;
    }));
  }

  function showCalendar(open: boolean) {
    if (open) {
      const [year, month] = ISO.test(dateInput.value) ? dateInput.value.split('-').map(Number) : [today.getFullYear(), today.getMonth() + 1];
      showMonth(year, month - 1);
    }
    $('cal-pop').hidden = !open;
    $('date-btn').setAttribute('aria-expanded', String(open));
  }

  const onClick = (id: string, action: () => void) => $(id).addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    action();
  });
  onClick('date-btn', () => showCalendar($('cal-pop').hidden));
  onClick('cal-prev', () => showMonth(shown.getFullYear(), shown.getMonth() - 1));
  onClick('cal-next', () => showMonth(shown.getFullYear(), shown.getMonth() + 1));
  onClick('cal-lbl', () => showMonth(today.getFullYear(), today.getMonth()));
  onClick('cal-today', () => showMonth(today.getFullYear(), today.getMonth()));
  document.addEventListener('click', event => { if (!$('f-eventdate').contains(event.target as Node)) showCalendar(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') showCalendar(false); });

  async function checkToken() {
    $('token-status').classList.add('checking');
    $('token-status-text').textContent = 'Checking the Confluence token…';
    let text: string;
    try {
      text = 'Confluence token found in .env · ' + (await api<{ message: string }>('/api/token')).message;
      tokenWorks = true;
    } catch (error) {
      text = (error as Error).message;
      tokenWorks = false;
    }
    $('token-status').classList.remove('checking');
    $('token-status').classList.toggle('bad', !tokenWorks);
    $('token-status-text').textContent = text;
    $('token-recheck').hidden = tokenWorks;
  }
  $('token-recheck').addEventListener('click', checkToken);
  checkToken();

  const fillSelect = (select: HTMLSelectElement, values: string[], placeholder: string) =>
    select.replaceChildren(new Option(placeholder, ''), ...values.map(value => new Option(value, value)));

  api<{ apps: string[] }>('/api/apps')
    .then(({ apps }) => fillSelect(appSelect, apps, '— Select app —'))
    .catch((error: Error) => mark('app', error.message));

  appSelect.addEventListener('change', async () => {
    fromSelect.disabled = toSelect.disabled = true;
    if (!appSelect.value) return;
    try {
      const { tags } = await api<{ tags: string[] }>(`/api/tags?app=${encodeURIComponent(appSelect.value)}`);
      const olds = tags.filter(tag => tag.endsWith('-OLD')), news = tags.filter(tag => tag.endsWith('-NEW'));
      fillSelect(fromSelect, olds, '— Select —');
      fillSelect(toSelect, news, '— Select —');
      fromSelect.value = olds[0] ?? '';
      toSelect.value = news[0] ?? '';
      fromSelect.disabled = toSelect.disabled = false;
      mark('app', tags.length ? '' : `No ${appSelect.value}-<n>-OLD / -NEW tags found`);
    } catch (error) {
      mark('app', (error as Error).message);
    }
  });

  $<HTMLFormElement>('mainForm').addEventListener('submit', async event => {
    event.preventDefault();
    const fields = { version: versionInput, eventdate: dateInput, app: appSelect, tagfrom: fromSelect, tagto: toSelect };
    for (const [id, input] of Object.entries(fields)) mark(id, input.value.trim() ? '' : 'Required');
    if (dateInput.value && !ISO.test(dateInput.value)) mark('eventdate', 'Format must be YYYY-MM-DD');
    if (!tokenWorks) {
      $('token-status').classList.add('shake');
      setTimeout(() => $('token-status').classList.remove('shake'), 450);
    }
    if (!tokenWorks || document.querySelector('.has-error')) return;

    const button = $<HTMLButtonElement>('submitBtn'), status = $('statusMsg');
    button.disabled = true;
    button.classList.add('loading');
    status.className = 'status-msg';
    status.textContent = 'Creating the release page…';
    try {
      const { pageUrl, pullRequestCount } = await api<{ pageUrl: string; pullRequestCount: number }>('/api/release', {
        app: appSelect.value, version: versionInput.value.trim(), date: dateInput.value, from: fromSelect.value, to: toSelect.value,
      });
      const link = Object.assign(document.createElement('a'), { href: pageUrl, target: '_blank', textContent: 'open in Confluence' });
      status.replaceChildren(`Release page created with ${pullRequestCount} PRs — `, link);
      status.classList.add('ok');
    } catch (error) {
      status.textContent = (error as Error).message;
      status.classList.add('err');
    }
    button.disabled = false;
    button.classList.remove('loading');
  });
}

function effectsScript(): void {
  (function hyperspeedIntro() {
    const overlay = document.getElementById('intro') as HTMLElement;
    const canvas = document.getElementById('introCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    const STAR_COUNT = 380;
    const MAX_SPEED = 38;
    const ACCEL_RATE = 1.062;
    const ACCEL_MS = 1400, HOLD_MS = 300, DECEL_MS = 420, FADE_MS = 750;
    const COLORS = ['#ffffff', '#ffffff', '#ffcccc', '#FF4444', '#CC0011', '#FF1A2E', '#FF6633', '#AA0008'];

    interface Star {
      x: number; y: number;
      prevX: number; prevY: number;
      angle: number;
      speed: number;
      width: number;
      color: string;
    }

    let width = 0, height = 0, centerX = 0, centerY = 0;
    let speed = 0.8;
    let phase: 'accel' | 'hold' | 'decel' = 'accel';
    let flashAlpha = 0;
    let flashed = false;
    let startTime = 0, frameId = 0;

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      centerX = width / 2;
      centerY = height / 2;
    }

    const random = (min: number, max: number) => min + Math.random() * (max - min);

    function makeStar(nearCenter: boolean): Star {
      const angle = Math.random() * Math.PI * 2;
      const distance = nearCenter ? Math.random() * 6 : Math.random() * Math.min(width, height) * 0.5;
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;
      return {
        x, y,
        prevX: x, prevY: y,
        angle,
        speed: nearCenter ? speed * random(0.2, 0.8) : speed * random(0.5, 1.5),
        width: random(0.35, 1.45),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      };
    }

    resize();
    const stars = Array.from({ length: STAR_COUNT }, (_, i) => makeStar(i < STAR_COUNT * 0.55));

    function drawGlow() {
      const strength = Math.min(1, speed / MAX_SPEED);
      if (strength < 0.05) return;
      const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 20 + strength * 260);
      glow.addColorStop(0, `rgba(255,20,40,${strength * 0.65})`);
      glow.addColorStop(0.35, `rgba(192,0,20,${strength * 0.4})`);
      glow.addColorStop(0.7, `rgba(120,0,10,${strength * 0.2})`);
      glow.addColorStop(1, 'transparent');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    function drawFlash() {
      if (flashAlpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = flashAlpha;
      ctx.fillStyle = '#CC0011';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    function moveStar(star: Star) {
      star.prevX = star.x;
      star.prevY = star.y;
      if (phase === 'accel') star.speed = Math.min(star.speed * ACCEL_RATE, MAX_SPEED * 2.8);
      else if (phase === 'decel') star.speed = Math.max(star.speed * 0.88, 0.3);
      star.x += Math.cos(star.angle) * star.speed;
      star.y += Math.sin(star.angle) * star.speed;

      if (star.x < -60 || star.x > width + 60 || star.y < -60 || star.y > height + 60) {
        Object.assign(star, makeStar(true), { speed: speed * (phase === 'decel' ? 0.15 : 0.25) });
        return;
      }

      ctx.beginPath();
      ctx.strokeStyle = star.color;
      ctx.lineWidth = star.width * Math.max(1, star.speed / 12);
      ctx.globalAlpha = Math.min(0.95, star.speed / 9);
      ctx.moveTo(star.prevX, star.prevY);
      ctx.lineTo(star.x, star.y);
      ctx.stroke();
    }

    function frame(now: number) {
      const elapsed = now - startTime;
      if (phase === 'accel' && elapsed >= ACCEL_MS) phase = 'hold';
      if (phase === 'hold' && elapsed >= ACCEL_MS + HOLD_MS) {
        phase = 'decel';
        if (!flashed) { flashed = true; flashAlpha = 0.55; }
      }
      if (phase === 'decel' && elapsed >= ACCEL_MS + HOLD_MS + DECEL_MS) {
        overlay.classList.add('fading');
        setTimeout(() => {
          overlay.style.display = 'none';
          window.dispatchEvent(new Event('intro-done'));
        }, FADE_MS);
        cancelAnimationFrame(frameId);
        return;
      }

      if (phase === 'accel') speed = Math.min(speed * ACCEL_RATE, MAX_SPEED);
      else if (phase === 'decel') speed = Math.max(speed * 0.9, 0.5);
      flashAlpha = Math.max(0, flashAlpha - 0.04);

      ctx.fillStyle = phase === 'decel' ? 'rgba(0,0,0,0.48)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(0, 0, width, height);
      stars.forEach(moveStar);
      ctx.globalAlpha = 1;
      drawGlow();
      drawFlash();
      frameId = requestAnimationFrame(frame);
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    startTime = performance.now();
    frameId = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
  })();

  (function heading() {
    const RISE = { stagger: 52, duration: 580 };
    const SLIDE = { stagger: 16, duration: 460 };
    const PAUSE = 52;

    function animateLine(line: HTMLElement, text: string) {
      const letters = [...text].map(char => {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = char;
        return span;
      });
      line.append(...letters);
      type Timing = { stagger: number; duration: number };
      const totalTime = ({ stagger, duration }: Timing) => (letters.length - 1) * stagger + duration;
      const play = (className: string, { stagger }: Timing) => letters.forEach((span, i) => {
        span.style.animationDelay = `${i * stagger}ms`;
        span.classList.add(className);
      });

      return new Promise<void>(resolve => {
        play('rising', RISE);
        setTimeout(() => {
          letters.forEach(span => { span.style.animationDelay = ''; span.classList.remove('rising'); });
          void line.offsetWidth;
          play('sliding', SLIDE);
          setTimeout(() => {
            letters.forEach(span => { span.style.animationDelay = ''; span.classList.replace('sliding', 'done'); });
            resolve();
          }, totalTime(SLIDE));
        }, totalTime(RISE) + PAUSE);
      });
    }

    const show = (id: string, delay = 0) => setTimeout(() => document.getElementById(id)!.classList.add('visible'), delay);

    window.addEventListener('intro-done', () => {
      document.getElementById('textReveal')!.classList.add('revealed');
      show('eyebrow');
      show('sithFigure');
      setTimeout(async () => {
        await Promise.all([
          animateLine(document.getElementById('line1')!, 'System Online'),
          animateLine(document.getElementById('line2')!, 'Ready for input'),
        ]);
        show('heroDivider');
        show('heroBody', 130);
      }, 150);
    }, { once: true });
  })();

  (function sith() {
    const SABER_DELAY = 5200, SABER_GROW = 1800;
    const HILT_TOP = 88;
    const rect = (id: string) => document.getElementById(id) as unknown as SVGRectElement;
    const blades: [SVGRectElement, number, number][] = [
      [rect('sx-so'), 70, 0.4],
      [rect('sx-sm'), 66, 0.75],
      [rect('sx-sc'), 62, 1],
    ];
    let firstFrame: number | null = null;

    function growSaber(now: number) {
      firstFrame ??= now;
      const elapsed = now - firstFrame;
      const progress = Math.max(0, Math.min(1, (elapsed - SABER_DELAY) / SABER_GROW));
      const eased = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
      for (const [blade, fullHeight, opacity] of blades) {
        const height = fullHeight * eased;
        blade.setAttribute('height', String(height));
        blade.setAttribute('y', String(HILT_TOP - height));
        if (progress > 0) blade.style.opacity = String(opacity);
      }
      if (elapsed < SABER_DELAY + SABER_GROW + 300) requestAnimationFrame(growSaber);
    }
    requestAnimationFrame(growSaber);

    function flashBolt(bolt: SVGElement, minWait: number, maxWait: number) {
      setTimeout(() => {
        const flicker: [number, string][] = [[0, '1'], [80, '0.25'], [140, '1'], [200, '0.6'], [260, '1'], [340, '0']];
        for (const [at, opacity] of flicker) setTimeout(() => { bolt.style.opacity = opacity; }, at);
        flashBolt(bolt, minWait, maxWait);
      }, minWait + Math.random() * (maxWait - minWait));
    }

    setTimeout(() => {
      const bolt = (id: string) => document.getElementById(id) as unknown as SVGElement;
      flashBolt(bolt('sx-b1'), 1200, 3500);
      setTimeout(() => flashBolt(bolt('sx-b2'), 1800, 4200), 700);
    }, 7000);
  })();
}

const STYLE = `*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {

  --red:          #C0001A;
  --red-hot:      #FF1A2E;

  --ok:           #22C55E;
  --err:          #FF3333;
  --err-label:    #FF5555;

  --bg-body:      #0B0004;
  --bg-card:      #0E0007;
  --bg-input:     #160009;
  --bg-input-f:   #1E000D;

  --white:        #FFFFFF;
  --text-input:   rgba(255, 220, 220, 0.92);
  --label:        rgba(255, 160, 160, 0.62);
  --label-f:      rgba(220, 50, 70, 0.95);
  --border:       rgba(192, 0, 26, 0.22);
  --border-f:     rgba(192, 0, 26, 0.75);
}

html,
body {
  height: 100%;
  background: var(--bg-body);
  color: var(--white);
  font-family: 'DM Sans', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.hero {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 56% 44%;
}

.hero-left {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 3.75rem 3.75rem 3.75rem 4rem;
}

.hero-right {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 3rem 2.75rem;
  overflow-y: auto;
}

.hero-right::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  background: var(--border);
}

.hero-left-content {
  position: relative;
  z-index: 3;
}

.hero-left-content::before {
  content: '';
  display: block;
  width: 32px;
  height: 2px;
  margin-bottom: 1.1rem;
  border-radius: 2px;
  background: var(--red);
}

.eyebrow {
  margin-bottom: 1rem;
  font-size: 0.6rem;
  font-weight: 500;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: rgba(220, 30, 50, 0.85);
  text-shadow: 0 0 12px rgba(255, 0, 30, 0.5);
}

.line {
  display: flex;
  flex-wrap: wrap;
  line-height: 1;
}

.line + .line {
  margin-top: 0.08em;
}

.char {
  display: inline-block;
  white-space: pre;
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: clamp(2.6rem, 4.5vw, 4.25rem);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--white);
  text-shadow: 0 0 40px rgba(220, 0, 20, 0.55), 0 0 90px rgba(180, 0, 10, 0.3);
}

#line2 .char {
  font-size: clamp(2rem, 3.5vw, 3.25rem);
  font-weight: 400;
  font-style: italic;
  color: rgba(255, 180, 180, 0.72);
  text-shadow: 0 0 40px rgba(200, 0, 15, 0.4), 0 0 80px rgba(150, 0, 10, 0.2);
}

.hero-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0;
}

.hero-divider::before {
  content: '';
  display: block;
  width: 40px;
  height: 1px;
  background: var(--red);
}

.hero-body-text {
  max-width: 38ch;
  font-size: 0.9375rem;
  font-weight: 300;
  line-height: 1.72;
  letter-spacing: 0.015em;
  color: rgba(255, 210, 210, 0.72);
}

.form-card {
  position: relative;
  overflow: hidden;
  padding: 2.25rem 2.25rem 2rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-card);
}

.form-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--red);
}

.form-tag {
  display: block;
  margin-bottom: 0.55rem;
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: #FF3A52;
  text-shadow: 0 0 10px rgba(220, 0, 30, 0.5);
}

.form-title {
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-size: 1.9rem;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.025em;
  color: var(--white);
  text-shadow: 0 0 30px rgba(200, 0, 20, 0.25);
}

.form-sub {
  margin-top: 0.3rem;
  font-size: 0.8rem;
  font-weight: 300;
  line-height: 1.55;
  letter-spacing: 0.01em;
  color: rgba(255, 190, 190, 0.62);
}

.form-rule {
  height: 1px;
  margin: 1.4rem 0 1.65rem;
  background: rgba(192, 0, 26, 0.18);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  row-gap: 0;
  column-gap: 1.25rem;
}

.field {
  position: relative;
  margin-bottom: 1.4rem;
}

.field.full-width {
  grid-column: 1 / -1;
}

label {
  position: absolute;
  top: 0.72rem;
  left: 0.85rem;
  z-index: 1;
  padding: 0 0.2rem;
  font-size: 0.8125rem;
  font-weight: 400;
  white-space: nowrap;
  color: var(--label);
  background: transparent;
  pointer-events: none;
  transition:
    top 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    font-size 0.18s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.18s ease,
    font-weight 0.18s ease;
}

.field:focus-within label,
.field.filled label {
  top: -0.52rem;
  font-size: 0.635rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--label-f);
  background: var(--bg-card);
}

select,
input[type="text"] {
  width: 100%;
  padding: 0.72rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--text-input);
  background: var(--bg-input);
  appearance: none;
  -webkit-appearance: none;
  transition:
    border-color 0.18s ease,
    box-shadow 0.2s ease,
    background 0.18s ease;
}

input::placeholder {
  color: transparent;
}

select {
  height: 2.85rem;
  padding-top: 1.15rem;
  padding-right: 2.25rem;
  padding-bottom: 0.3rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='rgba(200%2C80%2C80%2C0.6)' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.85rem center;
  cursor: pointer;
}

.field:has(select) label {
  top: -0.52rem;
  font-size: 0.635rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--label-f);
  background: var(--bg-card);
}

select option {
  color: #FFD0D0;
  background: #1A0008;
}

select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

select:focus,
input[type="text"]:focus {
  border-color: var(--border-f);
  background: var(--bg-input-f);
  box-shadow: 0 0 0 3px rgba(192, 0, 26, 0.12), 0 0 16px rgba(192, 0, 26, 0.08);
}

.err-msg {
  display: block;
  margin-top: 0.3rem;
  font-size: 0.66rem;
  font-weight: 400;
  line-height: 1.4;
  color: var(--err-label);
  overflow-wrap: anywhere;
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.err-msg:empty {
  display: none;
}

.field.has-error .err-msg {
  opacity: 1;
  transform: translateY(0);
}

.field.has-error label {
  color: var(--err-label);
}

.field.has-error select,
.field.has-error input {
  border-color: var(--err);
  background: rgba(255, 0, 0, 0.06);
  box-shadow: 0 0 0 3px rgba(255, 0, 0, 0.08);
}

.field.is-valid::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 0.75rem;
  z-index: 2;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--ok) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6l2.5 2.5 4.5-5' stroke='white' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat center;
  transform: translateY(-50%);
  pointer-events: none;
}

.field.is-valid.no-badge::after {
  display: none;
}

.field.is-valid select,
.field.is-valid input {
  border-color: rgba(192, 0, 26, 0.6);
  background: rgba(192, 0, 26, 0.08);
}

.date-wrap {
  position: relative;
}

.date-wrap input[type="text"] {
  padding-right: 2.6rem;
  letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums;
}

.date-fmt {
  margin-left: 0.35rem;
  font-size: 0.57rem;
  font-weight: 400;
  letter-spacing: 0.08em;
  color: rgba(192, 0, 26, 0.45);
}

.date-btn {
  position: absolute;
  top: 50%;
  right: 0.55rem;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 4px;
  color: rgba(192, 0, 26, 0.6);
  background: none;
  transform: translateY(-50%);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.date-btn:hover {
  color: rgba(255, 80, 80, 0.95);
  background: rgba(192, 0, 26, 0.1);
}

.date-btn svg {
  display: block;
  width: 15px;
  height: 15px;
  pointer-events: none;
}

.field.is-valid .date-btn {
  color: rgba(34, 197, 94, 0.85);
}

.field.has-error .date-btn {
  color: rgba(255, 50, 50, 0.85);
}

.cal-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 999;
  width: 256px;
  padding: 10px;
  border: 1px solid rgba(192, 0, 26, 0.35);
  border-radius: 6px;
  background: #110007;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 40px rgba(192, 0, 26, 0.08);
}

.cal-pop[hidden] {
  display: none;
}

.cal-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.cal-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 4px;
  font-size: 1.3rem;
  line-height: 1;
  color: rgba(192, 0, 26, 0.7);
  background: none;
  cursor: pointer;
  transition:
    color 0.12s,
    background 0.12s;
}

.cal-nav:hover {
  color: #FF3333;
  background: rgba(192, 0, 26, 0.1);
}

.cal-lbl {
  padding: 3px 6px;
  border: none;
  border-radius: 4px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: rgba(255, 200, 200, 0.9);
  background: none;
  cursor: pointer;
  transition: background 0.12s;
}

.cal-lbl:hover {
  background: rgba(192, 0, 26, 0.1);
}

.cal-wdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}

.cal-wdays span {
  padding: 3px 0;
  text-align: center;
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  color: rgba(192, 0, 26, 0.6);
}

.cal-days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 1px;
}

.cal-day {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  border: none;
  border-radius: 4px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.75rem;
  color: rgba(255, 210, 210, 0.8);
  background: none;
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s;
}

.cal-day:hover {
  color: var(--white);
  background: rgba(192, 0, 26, 0.18);
}

.cal-day.dim {
  color: rgba(255, 180, 180, 0.22);
}

.cal-day.today {
  border: 1px solid rgba(192, 0, 26, 0.5);
  font-weight: 600;
  color: #FF6666;
}

.cal-day.sel {
  font-weight: 600;
  color: var(--white);
  background: var(--red);
  box-shadow: 0 0 10px rgba(192, 0, 26, 0.5);
}

.cal-day.sel:hover {
  background: var(--red-hot);
}

.cal-foot {
  display: flex;
  justify-content: center;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(192, 0, 26, 0.15);
}

.cal-today-btn {
  padding: 4px 14px;
  border: 1px solid rgba(192, 0, 26, 0.3);
  border-radius: 3px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  color: rgba(220, 60, 60, 0.85);
  background: none;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}

.cal-today-btn:hover {
  color: #FF4444;
  background: rgba(192, 0, 26, 0.12);
}

.token-status {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.5rem;
  row-gap: 0.3rem;
  align-items: start;
  margin-bottom: 1.4rem;
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--text-input);
  overflow-wrap: anywhere;
}

.token-status-dot {
  width: 8px;
  height: 8px;
  margin-top: 0.4em;
  border-radius: 50%;
  background: var(--ok);
}

.token-status-text,
.token-status-btn {
  grid-column: 2;
  justify-self: start;
}

.token-status.bad .token-status-dot {
  background: var(--err);
}

.token-status.bad .token-status-text {
  color: var(--err-label);
}

.token-status.checking .token-status-dot {
  background: #666666;
}

.token-status-btn {
  padding: 0;
  border: none;
  font: inherit;
  text-decoration: underline;
  color: var(--label-f);
  background: none;
  cursor: pointer;
}

.token-status-btn:hover {
  color: var(--red-hot);
}

.token-status-btn[hidden] {
  display: none;
}

.submit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin-top: 0.4rem;
  padding-top: 1.4rem;
  border-top: 1px solid rgba(192, 0, 26, 0.18);
}

.btn-submit {
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
  padding: 0.8125rem 2.1rem;
  border: none;
  border-radius: 3px;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--white);
  background: var(--red);
  cursor: pointer;
  transition:
    background 0.2s ease,
    transform 0.1s ease;
}

.btn-submit:hover {
  background: var(--red-hot);
}

.btn-submit:active {
  transform: scale(0.975);
}

.btn-submit:disabled {
  background: #666666;
  cursor: not-allowed;
}

.btn-submit.loading {
  padding-right: 2.6rem;
}

.status-msg {
  min-height: 1rem;
  font-size: 0.8rem;
  font-weight: 400;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.status-msg.ok {
  color: #FF6B6B;
  opacity: 1;
}

.status-msg.err {
  color: #FF4444;
  opacity: 1;
}

.status-msg a {
  color: inherit;
  text-decoration: underline;
}

@media (max-width: 820px) {
  .hero {
    grid-template-columns: 1fr;
    min-height: auto;
  }

  .hero-left {
    min-height: 55vw;
    padding: 2.5rem 1.75rem;
  }

  .hero-right {
    padding: 2rem 1.5rem 3rem;
  }

  .hero-right::before {
    display: none;
  }
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

#intro {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: #000000;
  pointer-events: none;
}

#introCanvas {
  display: block;
  width: 100%;
  height: 100%;
}

#intro.fading {
  opacity: 0;
  transition: opacity 0.75s cubic-bezier(0.4, 0, 0.2, 1);
}

.hero-left-content::before {
  opacity: 0;
  transition: opacity 0.6s ease 0.1s;
}

.hero-left-content.revealed::before {
  opacity: 1;
}

.eyebrow,
.hero-divider {
  opacity: 0;
  transition: opacity 0.5s ease;
}

.eyebrow.visible,
.hero-divider.visible {
  opacity: 1;
}

.hero-body {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 640ms ease,
    transform 640ms ease;
}

.hero-body.visible {
  opacity: 1;
  transform: translateY(0);
}

:root {
  --rise-start: 65px;
  --slide-start: 48px;
  --rise-time: 580ms;
  --slide-time: 460ms;
}

.char {
  opacity: 0;
  transform: translateY(var(--rise-start)) translateX(var(--slide-start));
  will-change: transform, opacity;
}

.char.rising {
  animation: rise var(--rise-time) cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.char.sliding {
  opacity: 1;
  transform: translateY(0) translateX(var(--slide-start));
  animation: slide var(--slide-time) cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.char.done {
  opacity: 1;
  transform: translateY(0) translateX(0);
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(var(--rise-start)) translateX(var(--slide-start));
  }
  to {
    opacity: 1;
    transform: translateY(0) translateX(var(--slide-start));
  }
}

@keyframes slide {
  from {
    transform: translateY(0) translateX(var(--slide-start));
  }
  to {
    transform: translateY(0) translateX(0);
  }
}

.sith-wrap {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: clamp(180px, 34%, 270px);
  opacity: 0;
  transform: translate(-50%, -58%);
  filter: drop-shadow(0 0 40px rgba(200, 0, 20, 0.45)) drop-shadow(0 0 80px rgba(150, 0, 10, 0.25));
  pointer-events: none;
  transition: opacity 1.8s ease;
}

.sith-wrap.visible {
  opacity: 1;
}

.sith-wrap svg {
  display: block;
  width: 100%;
  height: auto;
}

.sx-svg   { animation: sx-shadowGrow   8s forwards; }
.sx-bg    { animation: sx-bgTransform  8s forwards ease-in-out; }
.sx-skin  { animation: sx-skinFade     8s forwards ease-in-out; }
.sx-hair  { animation: sx-hairFade     8s forwards ease-in-out; }
.sx-eye   { animation: sx-eyeXform     8s forwards ease-in-out; }
.sx-mouth { animation: sx-mouthFade    8s forwards ease-in-out; }
.sx-dark  { animation: sx-darkOverlay  8s forwards ease-in-out; }
.sx-hood  { animation: sx-hoodAppear   8s forwards ease-in-out; }
.sx-tat   { animation: sx-tattooAppear 8s forwards ease-in-out; }
.sx-pupil { animation: sx-eyePupil     8s forwards; }
.sx-eglow { animation: sx-eyeGlowIn    8s forwards, sx-eyePulseLoop 2.5s 8s ease-in-out infinite; }
.sx-flash { animation: sx-flashIn      8s forwards; pointer-events: none; }
.sx-amb   { animation: sx-glowIn       8s forwards; }
.sx-aura  { animation: sx-auraIn       8s forwards, sx-auraLoop 4s 8s infinite; }
.sx-sbo   { animation: sx-saberPulse   1.8s 8s infinite; }
.sx-sbc   { animation: sx-corePulse    2.3s 8s infinite; }
#sx-root  { animation: sx-float        4s 8.2s ease-in-out infinite; display: block; }

@keyframes sx-bgTransform  { 0%, 60% { fill: #FF5630; } 100% { fill: #1A0000; } }
@keyframes sx-skinFade     { 0%, 60% { fill: #FFE2D9; } 100% { fill: #1E0E0E; } }
@keyframes sx-hairFade     { 0%, 55% { fill: #FFAB00; } 100% { fill: #110404; } }
@keyframes sx-eyeXform     { 0%, 55% { fill: #344563; } 85% { fill: #FFCC00; } 100% { fill: #FFAA00; } }
@keyframes sx-mouthFade    { 0%, 60% { fill: #DE350B; } 100% { fill: #440000; } }

@keyframes sx-darkOverlay  { 0%, 40% { opacity: 0; } 100% { opacity: 0.82; } }
@keyframes sx-hoodAppear   { 0%, 50% { opacity: 0; } 100% { opacity: 1; } }
@keyframes sx-tattooAppear { 0%, 65% { opacity: 0; } 100% { opacity: 0.75; } }
@keyframes sx-eyePupil     { 0%, 65% { opacity: 0; } 100% { opacity: 1; } }
@keyframes sx-eyeGlowIn    { 0%, 65% { opacity: 0; } 80% { opacity: 0.9; } 90% { opacity: 0.5; } 100% { opacity: 0.8; } }
@keyframes sx-glowIn       { 0%, 55% { opacity: 0; } 100% { opacity: 0.2; } }
@keyframes sx-auraIn       { 0%, 60% { opacity: 0; } 100% { opacity: 1; } }
@keyframes sx-flashIn      { 0%, 58% { opacity: 0; } 62% { opacity: 0.7; } 66%, 100% { opacity: 0; } }
@keyframes sx-shadowGrow   { 0%, 55% { filter: none; } 100% { filter: drop-shadow(0 0 18px rgba(180, 0, 0, 0.7)) drop-shadow(0 0 36px rgba(100, 0, 0, 0.4)); } }

@keyframes sx-eyePulseLoop { 0%, 100% { opacity: 0.75; } 50% { opacity: 0.3; } }
@keyframes sx-auraLoop     { 0%, 100% { stroke-width: 2; opacity: 0.2; } 50% { stroke-width: 1; opacity: 0.06; } }
@keyframes sx-saberPulse   { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.65; } }
@keyframes sx-corePulse    { 0%, 100% { opacity: 1; } 92% { opacity: 0.85; } 96% { opacity: 1; } }
@keyframes sx-float        { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

.form-card {
  opacity: 0;
  transform: translateY(14px);
  animation: cardIn 0.75s cubic-bezier(0.22, 1, 0.36, 1) 0.15s forwards;
}

@keyframes cardIn {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.cal-pop {
  animation: calDrop 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes calDrop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.token-status.shake {
  animation: shake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  15%      { transform: translateX(-6px); }
  30%      { transform: translateX(5px); }
  45%      { transform: translateX(-4px); }
  60%      { transform: translateX(3px); }
  75%      { transform: translateX(-2px); }
  90%      { transform: translateX(1px); }
}

.btn-spinner {
  display: none;
  position: absolute;
  top: 50%;
  right: 0.8rem;
  width: 13px;
  height: 13px;
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--white);
  border-radius: 50%;
  transform: translateY(-50%);
  animation: spin 0.65s linear infinite;
}

.btn-submit.loading .btn-spinner {
  display: block;
}

@keyframes spin {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}
`;

const FORM_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Systemet</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,300;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet"/>
  <style>
${STYLE}  </style>
</head>
<body>
<main class="hero">
  <div class="hero-left">
    <div class="sith-wrap" id="sithFigure" aria-hidden="true">
      <svg id="sx-root" class="sx-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" style="width:100%;height:auto;display:block;">
        <defs>
          <filter id="sx-sf"  x="-60%" y="-5%"   width="220%" height="110%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="sx-gr"  x="-40%" y="-40%"  width="180%" height="180%"><feGaussianBlur stdDeviation="2"   result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="sx-sb"                                                ><feGaussianBlur stdDeviation="1.5"/></filter>
          <filter id="sx-eg"  x="-80%" y="-80%"  width="260%" height="260%"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <linearGradient id="sx-cl" x1="0%" y1="0%" x2="60%" y2="100%"><stop offset="0%"   stop-color="#1c0808"/><stop offset="100%" stop-color="#060202"/></linearGradient>
          <linearGradient id="sx-hl" x1="0%" y1="0%" x2="40%" y2="100%"><stop offset="0%"   stop-color="#1a0606"/><stop offset="100%" stop-color="#060101"/></linearGradient>
        </defs>
        <path class="sx-bg"   d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z"/>
        <path class="sx-hair" d="M102.5 66c.5-3.5-1.5-7-4.5-9-1.5-1-2.5-3-1.5-4.5s1-3.5.5-5.5c-.5-3-3.5-5.5-7-6-4.5-12-16.5-20.5-30-20.5S35 29 30.5 41C27 41 24 43.5 23 47c-.5 2-.5 3.5.5 5.5.5 2 .5 3.5-1.5 4.5-3 2-5.5 5.5-5 9 .5 4 3 7 6.5 8.5v13c0 2 1.5 4 4 4h63c2.5 0 4.5-1.5 4-4V75c4.5-1 8-4 8-9z"/>
        <path class="sx-skin" d="M60 103c-16 0-29.5-13-29.5-29.5v-26H89V74c.5 16-13 29-29 29z"/>
        <path class="sx-hair" d="M74.5 44.5h-46v17H43c8.5 0 13.5-5.5 15.5-8.5.5-.5 2-.5 2.5 0 2.5 4 8.5 12 19.5 12h11V44l-17 .5z"/>
        <circle class="sx-eye"  cx="48"   cy="72.5" r="3.5"/>
        <circle class="sx-eye"  cx="70.5" cy="72.5" r="3.5"/>
        <path   class="sx-eye"  d="M60 96c5.5 0 9.5-3.5 11.5-8.5.5-2-.5-4-3-4h-17c-2.5 0-3.5 2-3 4 2 5 6 8.5 11.5 8.5z"/>
        <path   class="sx-mouth" d="M60 90c-3 0-5 2-6.5 4 2 1.5 4 2 6.5 2s4.5-.5 6.5-2c-1-2-3.5-4-6.5-4z"/>
        <path class="sx-dark" d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z" fill="#000" opacity="0"/>
        <ellipse class="sx-amb" cx="60" cy="118" rx="50" ry="5" fill="#cc0000" opacity="0" filter="url(#sx-sb)"/>
        <circle  class="sx-aura" cx="60" cy="60" r="65" fill="none" stroke="#cc0000" stroke-width="2" opacity="0" filter="url(#sx-gr)"/>
        <g class="sx-hood" opacity="0">
          <path d="M18,72 C15,85 12,100 10,120 L110,120 C108,100 105,85 102,72 Z" fill="url(#sx-cl)" stroke="#1a0404" stroke-width="0.5"/>
          <path d="M38,74 C36,90 34,105 33,120" stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <path d="M60,75 C60,92 60,107 60,120"  stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <path d="M82,74 C84,90 86,105 87,120" stroke="#0a0202" stroke-width="1" fill="none" opacity="0.5"/>
          <ellipse cx="60" cy="52" rx="38" ry="42" fill="url(#sx-hl)"/>
          <ellipse cx="60" cy="48" rx="30" ry="34" fill="#080202" opacity="0.88"/>
          <path d="M22,38 C24,50 26,62 28,78 C31,65 34,52 38,44 Z" fill="#0d0303" opacity="0.9"/>
          <path d="M98,38 C96,50 94,62 92,78 C89,65 86,52 82,44 Z" fill="#0d0303" opacity="0.9"/>
          <path d="M38,22 C45,18 60,16 75,18 C83,20 88,26 90,30 C82,26 72,23 60,22 C48,23 38,26 30,30 Z" fill="#060101" opacity="0.95"/>
          <rect x="93" y="88" width="5.5" height="18" rx="1.5" fill="#1a1a1a" stroke="#333" stroke-width="0.4"/>
          <rect x="93.2" y="89.5" width="5" height="3" rx="0.8" fill="#2a2a2a"/>
          <circle cx="95.75" cy="101" r="1.5" fill="#550000" stroke="#880000" stroke-width="0.4"/>
          <rect x="92.5" y="104" width="6.5" height="1.5" rx="1" fill="#222"/>
        </g>
        <g class="sx-tat" opacity="0">
          <path d="M33,68 L40,67 M32,72 L39,72 M34,76 L40,75" stroke="#cc0000" stroke-width="0.8" fill="none"/>
          <path d="M87,68 L80,67 M88,72 L81,72 M86,76 L80,75" stroke="#cc0000" stroke-width="0.8" fill="none"/>
          <path d="M60,38 L63,42 L60,46 L57,42 Z"            stroke="#990000" stroke-width="0.7" fill="none"/>
          <path d="M60,39.5 L60,44.5 M57.5,42 L62.5,42"      stroke="#660000" stroke-width="0.5" fill="none"/>
        </g>
        <g class="sx-pupil" opacity="0">
          <ellipse cx="48"   cy="72.5" rx="7"   ry="5"   fill="#0a0000"/>
          <ellipse cx="70.5" cy="72.5" rx="7"   ry="5"   fill="#0a0000"/>
          <ellipse cx="48"   cy="72.5" rx="5.5" ry="4"   fill="#cc6600"/>
          <ellipse cx="70.5" cy="72.5" rx="5.5" ry="4"   fill="#cc6600"/>
          <ellipse cx="48"   cy="72.5" rx="4"   ry="2.8" fill="#ffcc00"/>
          <ellipse cx="70.5" cy="72.5" rx="4"   ry="2.8" fill="#ffcc00"/>
          <polygon points="48,69 49.2,72.5 48,76 46.8,72.5"     fill="#050000"/>
          <polygon points="70.5,69 71.7,72.5 70.5,76 69.3,72.5" fill="#050000"/>
          <line x1="42" y1="67.5" x2="52" y2="69.5" stroke="#1a0000" stroke-width="1.8" stroke-linecap="round"/>
          <line x1="65" y1="69.5" x2="75" y2="67.5" stroke="#1a0000" stroke-width="1.8" stroke-linecap="round"/>
          <ellipse cx="45.5" cy="71" rx="1" ry="0.7" fill="#fff8cc" opacity="0.6"/>
          <ellipse cx="68"   cy="71" rx="1" ry="0.7" fill="#fff8cc" opacity="0.6"/>
        </g>
        <g class="sx-eglow" opacity="0" filter="url(#sx-eg)">
          <ellipse cx="48"   cy="72.5" rx="8"   ry="6"   fill="#ff6600" opacity="0.18"/>
          <ellipse cx="70.5" cy="72.5" rx="8"   ry="6"   fill="#ff6600" opacity="0.18"/>
          <ellipse cx="48"   cy="72.5" rx="5.5" ry="4"   fill="none" stroke="#ffaa00" stroke-width="1.2"/>
          <ellipse cx="70.5" cy="72.5" rx="5.5" ry="4"   fill="none" stroke="#ffaa00" stroke-width="1.2"/>
        </g>
        <rect class="sx-sbo" id="sx-so" x="93.5" y="88" width="4.5" height="0" rx="2"   fill="#ff0000" opacity="0" filter="url(#sx-sf)"/>
        <rect class="sx-sbo" id="sx-sm" x="94"   y="88" width="3.5" height="0" rx="1.5" fill="#ff3333" opacity="0" filter="url(#sx-sf)"/>
        <rect class="sx-sbc" id="sx-sc" x="94.8" y="88" width="2"   height="0" rx="1"   fill="#ffffff" opacity="0"/>
        <g id="sx-b1" opacity="0" filter="url(#sx-gr)">
          <polyline points="18,85 10,76 5,79 -2,68 -8,71 -14,61" stroke="#cc00ff" stroke-width="1.2" fill="none" stroke-linecap="round"/>
          <polyline points="18,85 12,74 7,77 2,66"                stroke="#ee88ff" stroke-width="0.7" fill="none" stroke-linecap="round"/>
          <polyline points="5,79 1,72 -2,75 -7,65"                stroke="#cc00ff" stroke-width="0.6" fill="none" stroke-linecap="round"/>
        </g>
        <g id="sx-b2" opacity="0" filter="url(#sx-gr)">
          <polyline points="102,85 110,76 115,79 122,68" stroke="#ff3388" stroke-width="1"   fill="none" stroke-linecap="round"/>
          <polyline points="110,76 114,70 118,73"         stroke="#ff88aa" stroke-width="0.6" fill="none" stroke-linecap="round"/>
        </g>
        <path class="sx-flash" d="M60 120C27 120 0 93 0 60S27 0 60 0s60 27 60 60-27 60-60 60z" fill="#fff" opacity="0"/>
      </svg>
    </div>
    <div class="hero-left-content" id="textReveal">
      <p class="eyebrow" id="eyebrow">System status</p>
      <div class="line" id="line1"></div>
      <div class="line" id="line2"></div>
      <div class="hero-divider" id="heroDivider"></div>
      <div class="hero-body" id="heroBody">
        <p class="hero-body-text">All systems are operational and standing by for your next command. Personal, thoughtful service — ready when you are.</p>
      </div>
    </div>
  </div>
  <div class="hero-right">
    <div class="form-card">
      <span class="form-tag">Release notes</span>
      <h1 class="form-title">Create a release page</h1>
      <p class="form-sub">Lists every merged change between two tags of an app and publishes it as a Confluence page.</p>
      <div class="form-rule"></div>
      <form id="mainForm" novalidate>
        <div class="form-grid">
          <div class="token-status checking" id="token-status" role="status" aria-live="polite">
            <span class="token-status-dot" aria-hidden="true"></span>
            <span class="token-status-text" id="token-status-text">Checking the Confluence token…</span>
            <button type="button" class="token-status-btn" id="token-recheck" hidden>Check again</button>
          </div>
          <div class="field full-width" id="f-app">
            <label for="app">App</label>
            <select id="app" name="app"><option value="">Loading apps…</option></select>
            <span class="err-msg" id="e-app"></span>
          </div>
          <div class="field" id="f-version">
            <label for="version">Version</label>
            <input type="text" id="version" name="version" maxlength="50" autocomplete="off" spellcheck="false"/>
            <span class="err-msg" id="e-version"></span>
          </div>
          <div class="field no-badge" id="f-eventdate">
            <label for="eventdate">Date <span class="date-fmt">YYYY-MM-DD</span></label>
            <div class="date-wrap">
              <input type="text" id="eventdate" name="eventdate" inputmode="numeric" maxlength="10" autocomplete="off" spellcheck="false"/>
              <button type="button" class="date-btn" id="date-btn" aria-label="Open calendar" aria-expanded="false">
                <svg viewBox="0 0 16 16" fill="none"><rect x="1" y="2.5" width="14" height="12.5" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M1 6.5h14" stroke="currentColor" stroke-width="1.2"/><path d="M5 1v3M11 1v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="4"  y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/><rect x="7"  y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/><rect x="10" y="9" width="2" height="2" rx="0.4" fill="currentColor" opacity="0.6"/></svg>
              </button>
              <div class="cal-pop" id="cal-pop" hidden>
                <div class="cal-hdr">
                  <button type="button" class="cal-nav" id="cal-prev">&#8249;</button>
                  <button type="button" class="cal-lbl" id="cal-lbl"></button>
                  <button type="button" class="cal-nav" id="cal-next">&#8250;</button>
                </div>
                <div class="cal-wdays"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span></div>
                <div class="cal-days" id="cal-days"></div>
                <div class="cal-foot"><button type="button" class="cal-today-btn" id="cal-today">Today</button></div>
              </div>
            </div>
            <span class="err-msg" id="e-eventdate"></span>
          </div>
          <div class="field" id="f-tagfrom">
            <label for="tagfrom">From tag (OLD)</label>
            <select id="tagfrom" name="tagfrom" disabled><option value="">Select an app first</option></select>
            <span class="err-msg" id="e-tagfrom"></span>
          </div>
          <div class="field" id="f-tagto">
            <label for="tagto">To tag (NEW)</label>
            <select id="tagto" name="tagto" disabled><option value="">Select an app first</option></select>
            <span class="err-msg" id="e-tagto"></span>
          </div>
        </div>
        <div class="submit-row">
          <button type="submit" class="btn-submit" id="submitBtn">Create page<span class="btn-spinner"></span></button>
          <span class="status-msg" id="statusMsg" role="status" aria-live="polite"></span>
        </div>
      </form>
    </div>
  </div>
</main>
<div id="intro" aria-hidden="true"><canvas id="introCanvas"></canvas></div>
<script>(${formScript})();</script>
<script>(${effectsScript})();</script>
</body>
</html>
`;

// ═════ START ════════════════════════════════════════════════════════════════

http.createServer(handleRequest).listen(PORT, '127.0.0.1', () => console.log(`Release page creator running at http://localhost:${PORT}/`));
