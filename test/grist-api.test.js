const test = require('node:test');
const assert = require('node:assert/strict');

const GristApi = require('../app/grist-api');

test('rejects path-like Grist document and table ids before sending requests', async () => {
  const originalFetch = global.fetch;
  let called = false;

  global.fetch = async () => {
    called = true;
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ tables: [], records: [] }),
    };
  };

  try {
    const badDocApi = new GristApi({ gristUrl: 'http://grist:8484', apiKey: 'key', docId: '../orgs/current' });
    await assert.rejects(() => badDocApi.getTables(), /Invalid Grist docId/);

    const api = new GristApi({ gristUrl: 'http://grist:8484', apiKey: 'key', docId: 'doc123' });
    await assert.rejects(() => api.getRecords('../orgs/current'), /Invalid Grist tableId/);

    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('updateTheme writes user theme prefs with current Grist session cookie', async () => {
  const originalFetch = global.fetch;
  let request = null;

  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
    };
  };

  try {
    const api = new GristApi({ gristUrl: 'http://grist:8484', apiKey: '', docId: '' });
    const themePrefs = {
      appearance: 'dark',
      syncWithOS: false,
      colors: { light: 'GristDark', dark: 'GristDark' },
    };

    await api.updateTheme(themePrefs, 'grist_core=session');

    assert.equal(request.url, 'http://grist:8484/api/orgs/current');
    assert.equal(request.options.method, 'PATCH');
    assert.equal(request.options.headers.Cookie, 'grist_core=session');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
      userPrefs: { theme: themePrefs },
    });
  } finally {
    global.fetch = originalFetch;
  }
});
