import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceSession, parseProperties, sessionFromCredentials } from '../web/js/jagex.js';

const CREDENTIALS = `#Do not share this file
#Mon Oct 12 21:00:00 BST 2026
JX_CHARACTER_ID=123456789
JX_DISPLAY_NAME=Zezima\\ Jr
JX_SESSION_ID=abc\\:def
`;

describe('parseProperties', () => {
  it('handles comments, escapes, separators and continuations', () => {
    const props = parseProperties('# c\n! c\na=1\nb : 2\nc 3\nd=x\\\n   y\ne=\\u0041\\tB\nf\\=g=h\n');
    assert.deepEqual(props, { a: '1', b: '2', c: '3', d: 'xy', e: 'A\tB', 'f=g': 'h' });
  });
});

describe('sessionFromCredentials', () => {
  it('extracts the JX_* variables', () => {
    assert.deepEqual(sessionFromCredentials(CREDENTIALS), {
      JX_SESSION_ID: 'abc:def',
      JX_CHARACTER_ID: '123456789',
      JX_DISPLAY_NAME: 'Zezima Jr',
    });
  });

  it('rejects files without a session', () => {
    assert.throws(() => sessionFromCredentials('foo=bar\n'), /missing JX_SESSION_ID, JX_CHARACTER_ID.*Found: foo/);
  });
});

describe('DeviceSession', () => {
  function setup(serverActive) {
    const data = new Map();
    const storage = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    };
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push([opts.method || 'GET', url, opts.body]);
      return { ok: true, json: async () => ({ active: serverActive }), text: async () => '' };
    };
    return { data, calls, a: new DeviceSession('/sam/', storage, fetchImpl), storage, fetchImpl };
  }

  it('saves per player path and sends the session', async () => {
    const { data, calls, a } = setup(false);
    const session = sessionFromCredentials(CREDENTIALS);
    await a.save(session);
    assert.deepEqual([...data.keys()], ['rlweb.jagexSession:/sam/']);
    assert.equal(a.displayName, 'Zezima Jr');
    assert.deepEqual(calls, [['PUT', 'api/runelite/session', JSON.stringify(session)]]);
  });

  it('resends only when RuneLite has no session', async () => {
    const idle = setup(false);
    assert.equal(await idle.a.syncIfNeeded(), false, 'nothing saved');
    await idle.a.save({ JX_SESSION_ID: 's', JX_CHARACTER_ID: 'c' });
    idle.calls.length = 0;
    assert.equal(await idle.a.syncIfNeeded(), true);
    assert.deepEqual(
      idle.calls.map((c) => c[0]),
      ['GET', 'PUT'],
    );

    const busy = setup(true);
    await busy.a.save({ JX_SESSION_ID: 's', JX_CHARACTER_ID: 'c' });
    busy.calls.length = 0;
    assert.equal(await busy.a.syncIfNeeded(), false);
    assert.deepEqual(
      busy.calls.map((c) => c[0]),
      ['GET'],
    );
  });

  it('remove forgets the session and clears it on the server', async () => {
    const { data, calls, a } = setup(true);
    await a.save({ JX_SESSION_ID: 's', JX_CHARACTER_ID: 'c' });
    await a.remove();
    assert.equal(data.size, 0);
    assert.equal(a.displayName, null);
    assert.deepEqual(calls.at(-1).slice(0, 2), ['DELETE', 'api/runelite/session']);
  });

  it('keeps a separate entry for each player path', async () => {
    const { a, storage, fetchImpl } = setup(false);
    await a.save({ JX_SESSION_ID: 's', JX_CHARACTER_ID: 'c' });
    assert.equal(new DeviceSession('/alex/', storage, fetchImpl).saved, null);
  });
});
