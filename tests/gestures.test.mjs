import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { GestureEngine } from '../web/js/gestures.js';

// The framebuffer is the screen at 2x: client (10, 20) -> fb (20, 40).
const FB = { w: 1600, h: 800 };
function toFb(cx, cy, { clamp = false } = {}) {
  let x = cx * 2;
  let y = cy * 2;
  if (!clamp && (x < 0 || y < 0 || x >= FB.w || y >= FB.h)) return null;
  x = Math.max(0, Math.min(FB.w - 1, x));
  y = Math.max(0, Math.min(FB.h - 1, y));
  return { x, y, ...FB };
}

let out;
let timers;
let feedback;
let engine;

function fireTimers() {
  const pending = [...timers.values()];
  timers.clear();
  pending.forEach((fn) => fn());
}

beforeEach(() => {
  out = [];
  feedback = [];
  timers = new Map();
  let nextId = 1;
  engine = new GestureEngine({
    emit: (a) => out.push(a),
    toFb,
    feedback: (e) => feedback.push(e),
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
});

const click = (b, x, y) => [
  { t: 'move', x, y },
  { t: 'btn', b, d: true },
  { t: 'btn', b, d: false },
];

describe('single finger', () => {
  it('tap sends one left-click at the touch point', () => {
    engine.pointerDown(1, 100, 50);
    engine.pointerUp(1, 102, 51);
    assert.deepEqual(out, click(1, 200, 100));
    assert.equal(timers.size, 0);
  });

  it('tap outside the video is ignored', () => {
    engine.pointerDown(1, 900, 50);
    engine.pointerUp(1, 900, 50);
    assert.deepEqual(out, []);
  });

  it('long-press then release sends a right-click', () => {
    engine.pointerDown(1, 100, 50);
    fireTimers();
    assert.deepEqual(out, []);
    assert.ok(feedback.includes('longpress'));
    engine.pointerUp(1, 100, 50);
    assert.deepEqual(out, click(3, 200, 100));
  });

  it('menu mode turns the next tap into a right-click, once', () => {
    engine.setMenuMode(true);
    engine.pointerDown(1, 100, 50);
    engine.pointerUp(1, 100, 50);
    assert.deepEqual(out, click(3, 200, 100));
    out = [];
    engine.pointerDown(1, 100, 50);
    engine.pointerUp(1, 100, 50);
    assert.deepEqual(out, click(1, 200, 100));
  });

  it('quick drag rotates the camera with a middle-button drag', () => {
    engine.pointerDown(1, 100, 50);
    engine.pointerMove(1, 130, 50);
    engine.pointerMove(1, 160, 60);
    engine.pointerUp(1, 160, 60);
    assert.deepEqual(out, [
      { t: 'move', x: 200, y: 100 },
      { t: 'btn', b: 2, d: true },
      { t: 'move', x: 260, y: 100 },
      { t: 'move', x: 320, y: 120 },
      { t: 'btn', b: 2, d: false },
    ]);
    assert.equal(timers.size, 0, 'long-press timer cancelled');
  });

  it('camera drag applies the sensitivity and clamps to the screen', () => {
    engine.updateSettings({ dragSensitivity: 2 });
    engine.pointerDown(1, 700, 50);
    engine.pointerMove(1, 750, 50);
    engine.pointerUp(1, 750, 50);
    assert.deepEqual(out.at(-2), { t: 'move', x: FB.w - 1, y: 100 });
  });

  it('long-press then drag moves an item with a left-button drag', () => {
    engine.pointerDown(1, 100, 50);
    fireTimers();
    engine.pointerMove(1, 140, 50);
    engine.pointerUp(1, 140, 50);
    assert.deepEqual(out, [
      { t: 'move', x: 200, y: 100 },
      { t: 'btn', b: 1, d: true },
      { t: 'move', x: 280, y: 100 },
      { t: 'btn', b: 1, d: false },
    ]);
  });

  it('cancel releases a held button', () => {
    engine.pointerDown(1, 100, 50);
    engine.pointerMove(1, 140, 50);
    engine.pointerCancel(1);
    assert.deepEqual(out.at(-1), { t: 'btn', b: 2, d: false });
  });
});

describe('two fingers', () => {
  it('pinching outwards zooms in with wheel-up at the centre', () => {
    engine.pointerDown(1, 100, 100);
    engine.pointerDown(2, 200, 100);
    engine.pointerMove(2, 290, 100); // distance 100 -> 190, 2 steps of 40
    assert.deepEqual(out, [
      { t: 'move', x: 390, y: 200 },
      { t: 'wheel', dir: 'up' },
      { t: 'wheel', dir: 'up' },
    ]);
  });

  it('pinching inwards zooms out', () => {
    engine.pointerDown(1, 100, 100);
    engine.pointerDown(2, 300, 100);
    engine.pointerMove(2, 250, 100); // 200 -> 150
    assert.deepEqual(
      out.filter((a) => a.t === 'wheel'),
      [{ t: 'wheel', dir: 'down' }],
    );
  });

  it('moving two fingers up scrolls with wheel-down', () => {
    engine.pointerDown(1, 100, 300);
    engine.pointerDown(2, 150, 300);
    // Touch events from both fingers arrive interleaved, a few pixels at a time.
    for (let y = 295; y >= 230; y -= 5) {
      engine.pointerMove(1, 100, y);
      engine.pointerMove(2, 150, y);
    } // centre moved up 70px: 2 steps of 32
    assert.deepEqual(
      out.filter((a) => a.t === 'wheel'),
      [
        { t: 'wheel', dir: 'down' },
        { t: 'wheel', dir: 'down' },
      ],
    );
  });

  it('second finger ends a camera drag and lifting one finger does not tap', () => {
    engine.pointerDown(1, 100, 50);
    engine.pointerMove(1, 130, 50);
    engine.pointerDown(2, 200, 50);
    assert.deepEqual(out.at(-1), { t: 'btn', b: 2, d: false });
    out = [];
    engine.pointerUp(2, 200, 50);
    engine.pointerUp(1, 130, 50);
    assert.deepEqual(out, []);
    engine.pointerDown(1, 100, 50);
    engine.pointerUp(1, 100, 50);
    assert.deepEqual(out, click(1, 200, 100), 'engine is usable again');
  });
});
