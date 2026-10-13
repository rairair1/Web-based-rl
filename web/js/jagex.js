// Jagex Account session, stored on this device only (like the official app
// keeps you signed in). The host never saves it: when RuneLite starts without
// a session, this device sends it again, and RuneLite gets it in memory.

export const SESSION_KEYS = [
  'JX_SESSION_ID',
  'JX_CHARACTER_ID',
  'JX_DISPLAY_NAME',
  'JX_ACCESS_TOKEN',
  'JX_REFRESH_TOKEN',
];
const REQUIRED_KEYS = ['JX_SESSION_ID', 'JX_CHARACTER_ID'];

/** Parses a Java .properties file, as written by RuneLite. */
export function parseProperties(text) {
  const out = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, '');
    if (!line || line[0] === '#' || line[0] === '!') continue;
    // A line ending in an odd number of backslashes continues on the next one.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '');
    }
    const match = /^((?:\\.|[^=:\s\\])*)[ \t\f]*[=:]?[ \t\f]*(.*)$/.exec(line);
    if (match) out[unescape(match[1])] = unescape(match[2]);
  }
  return out;
}

function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[e] ?? e;
  });
}

/** Picks the Jagex session out of a credentials.properties file. */
export function sessionFromCredentials(text) {
  const props = parseProperties(text);
  const byUpper = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.toUpperCase(), v]));
  const session = {};
  for (const key of SESSION_KEYS) if (byUpper[key]) session[key] = byUpper[key];
  const missing = REQUIRED_KEYS.filter((key) => !session[key]);
  if (missing.length) {
    throw new Error(
      `This doesn't look like RuneLite's credentials.properties (missing ${missing.join(', ')}). ` +
        `Found: ${Object.keys(props).join(', ') || 'nothing'}.`,
    );
  }
  return session;
}

export class DeviceSession {
  /**
   * @param {string} scope separates players who share one site, e.g. "/sam/"
   * @param {Storage} [storage]
   * @param {Function} [fetchImpl]
   */
  constructor(scope, storage = safeLocalStorage(), fetchImpl = (...args) => fetch(...args)) {
    this.key = `rlweb.jagexSession:${scope}`;
    this.storage = storage;
    this.fetch = fetchImpl;
  }

  get saved() {
    try {
      return JSON.parse(this.storage?.getItem(this.key) || 'null');
    } catch {
      return null;
    }
  }

  get displayName() {
    return this.saved?.JX_DISPLAY_NAME || (this.saved ? 'Jagex Account' : null);
  }

  /** Saves the session on this device and starts RuneLite with it. */
  async save(session) {
    if (!this.storage) throw new Error('This browser has storage turned off, so the account cannot be remembered.');
    this.storage.setItem(this.key, JSON.stringify(session));
    await this.send(session);
  }

  /** Forgets the session on this device and restarts RuneLite without it. */
  async remove() {
    this.storage?.removeItem(this.key);
    const res = await this.fetch('api/runelite/session', { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
  }

  /** Sends the saved session if RuneLite is running without one. Returns true if it did. */
  async syncIfNeeded() {
    const session = this.saved;
    if (!session) return false;
    const res = await this.fetch('api/runelite/session');
    if (!res.ok) return false;
    const status = await res.json();
    if (status.active) return false;
    await this.send(session);
    return true;
  }

  async send(session) {
    const res = await this.fetch('api/runelite/session', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error(`The server rejected the session: ${await res.text()}`);
  }
}

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
