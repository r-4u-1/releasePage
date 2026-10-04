// Checks a Confluence token. The release page itself is created by the release script.
const config = require('./config');
const { HttpError } = require('./web');

const BASE_URL = config.confluenceBaseUrl;

// Data Center: the token is a personal access token, sent as Bearer.
// Cloud: the token is sent together with the account email (Basic).
function authHeader(token) {
  if (!config.confluenceEmail) return 'Bearer ' + token;
  return 'Basic ' + Buffer.from(`${config.confluenceEmail}:${token}`).toString('base64');
}

const MESSAGES = {
  401: 'Token rejected by Confluence',
  403: 'Token has no access to this resource',
  404: 'Not found on Confluence',
};

// GETs a Confluence REST path. Returns the JSON answer, or throws an HttpError with a readable message.
async function request(path, token) {
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      headers: {
        Authorization: authHeader(token),
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Confluence');
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const message = MESSAGES[res.status] || data.message || `Confluence responded with HTTP ${res.status}`;
  throw new HttpError(res.status >= 400 ? res.status : 502, message);
}

// The name of the token's owner — proof that the token works.
async function currentUser(token) {
  const user = await request('/rest/api/user/current', token);
  if (user.type === 'anonymous') throw new HttpError(401, MESSAGES[401]); // Cloud, with a bad token
  return user.displayName || user.username || 'user';
}

module.exports = { currentUser };
