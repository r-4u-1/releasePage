'use strict';

const START_SERVER = 'Start the server with "npm run release-page" in the server folder, then open the address it prints (http://localhost:3000/).';

function notConnectedError(message) {
  return Object.assign(new Error(message + ' ' + START_SERVER), { notConnected: true });
}

async function api(url, body, signal) {
  const options = body === undefined ? { signal } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };

  if (location.protocol === 'file:') {
    throw notConnectedError('This page was opened as a file, so it can\'t reach the release server.');
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw notConnectedError(`Can't reach the release server at ${location.origin}: it isn't running.`);
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data.ok !== 'boolean') {
    throw notConnectedError(`This page isn't connected to the release server: ${location.host} answered "${url}" with HTTP ${res.status}.`);
  }
  if (!data.ok) {
    throw new Error(data.message || `The release server answered HTTP ${res.status} without saying why. Its terminal may show more.`);
  }
  return data;
}
