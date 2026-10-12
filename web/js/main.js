import RFB from '../novnc/core/rfb.js';
import { GestureEngine } from './gestures.js';
import { Keyboard } from './keyboard.js';
import { PROFILE_DEFAULTS, ProfileStore } from './profiles.js';

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const screenEl = $('#screen');
const touchEl = $('#touch');
const ring = $('#ring');
const statusEl = $('#status');

const profiles = new ProfileStore();
let settings = { ...PROFILE_DEFAULTS };
let rfb = null;

function wsUrl(path) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

// ---------------------------------------------------------------- input link

class InputLink {
  constructor() {
    this.queue = [];
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(wsUrl('ws/input'));
    this.ws.onopen = () => (this.retry = 0);
    this.ws.onclose = () => {
      this.retry = Math.min((this.retry || 0) + 1, 5);
      setTimeout(() => this.connect(), 500 * 2 ** this.retry);
    };
  }

  send(msg) {
    // Batch everything produced in one event-loop turn into a single frame.
    this.queue.push(msg);
    if (this.queue.length === 1) queueMicrotask(() => this.flush());
  }

  flush() {
    const batch = this.queue;
    this.queue = [];
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(batch));
  }
}

const input = new InputLink();

// ------------------------------------------------------------ video / display

function canvas() {
  return screenEl.querySelector('canvas');
}

/** Maps client coordinates to remote framebuffer coordinates. */
function toFb(cx, cy, { clamp = false } = {}) {
  const c = canvas();
  if (!c || !c.width) return null;
  const r = c.getBoundingClientRect();
  let x = ((cx - r.left) * c.width) / r.width;
  let y = ((cy - r.top) * c.height) / r.height;
  const inside = x >= 0 && y >= 0 && x < c.width && y < c.height;
  if (!inside && !clamp) return null;
  x = Math.max(0, Math.min(c.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(c.height - 1, Math.round(y)));
  return { x, y, w: c.width, h: c.height };
}

function layoutScreen() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (settings.displayMode === 'resize') {
    // Render the remote desktop larger than the phone's CSS pixels so the game
    // UI isn't cramped, then shrink it to fit with a transform.
    const s = Math.max(1, Math.min(3, settings.resolutionScale));
    screenEl.style.width = `${Math.round(w * s)}px`;
    screenEl.style.height = `${Math.round(h * s)}px`;
    screenEl.style.transform = `scale(${1 / s})`;
  } else {
    screenEl.style.width = `${w}px`;
    screenEl.style.height = `${h}px`;
    screenEl.style.transform = '';
  }
  if (rfb) {
    rfb.resizeSession = settings.displayMode === 'resize';
    rfb.scaleViewport = settings.displayMode !== 'resize';
  }
}

function connectVideo() {
  showStatus('Connecting…');
  rfb = new RFB(screenEl, wsUrl('ws/vnc'), { wsProtocols: ['binary'] });
  // noVNC measures its container with getBoundingClientRect(), which includes
  // our scale transform. Give it the untransformed layout size instead, so in
  // resize mode the remote desktop gets the larger resolution. (Private API;
  // noVNC is pinned in the Dockerfile and covered by tests/e2e.)
  rfb._screenSize = () => ({ w: screenEl.clientWidth, h: screenEl.clientHeight });
  rfb.focusOnClick = false;
  rfb.qualityLevel = settings.quality;
  rfb.compressionLevel = 2;
  rfb.background = '#000';
  layoutScreen();
  rfb.addEventListener('connect', () => showStatus(''));
  rfb.addEventListener('disconnect', (e) => {
    showStatus(e.detail.clean ? 'Disconnected. Reconnecting…' : 'Connection lost. Reconnecting…');
    rfb = null;
    setTimeout(connectVideo, 2000);
  });
}

new ResizeObserver(layoutScreen).observe(stage);

// ------------------------------------------------------------------ gestures

const gestures = new GestureEngine({
  emit: (msg) => input.send(msg),
  toFb,
  feedback(event, info) {
    if (event === 'longpress') {
      showRing(info.cx, info.cy, 'hold');
      if (settings.haptics) navigator.vibrate?.(15);
    } else if (event === 'tap') {
      showRing(info.cx, info.cy, info.right ? 'right' : 'tap');
      setMenuButton(false);
    } else if (event === 'end' && ring.dataset.kind === 'hold') {
      ring.hidden = true;
    }
  },
});

function showRing(cx, cy, kind) {
  ring.style.left = `${cx}px`;
  ring.style.top = `${cy}px`;
  ring.dataset.kind = kind;
  ring.hidden = false;
  ring.getAnimations().forEach((a) => a.cancel());
  if (kind !== 'hold') {
    ring.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350 }).onfinish = () => (ring.hidden = true);
  }
}

const mouseButton = (e) => ({ 0: 1, 1: 2, 2: 3 })[e.button] ?? 1;

touchEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  touchEl.setPointerCapture(e.pointerId);
  if (e.pointerType === 'mouse') {
    // Desktop browsers: pass the mouse straight through.
    const fb = toFb(e.clientX, e.clientY);
    if (fb) {
      input.send({ t: 'move', x: fb.x, y: fb.y });
      input.send({ t: 'btn', b: mouseButton(e), d: true });
    }
    return;
  }
  gestures.pointerDown(e.pointerId, e.clientX, e.clientY);
});

touchEl.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') {
    const fb = toFb(e.clientX, e.clientY, { clamp: true });
    if (fb) input.send({ t: 'move', x: fb.x, y: fb.y });
    return;
  }
  for (const ev of e.getCoalescedEvents?.() || [e]) gestures.pointerMove(e.pointerId, ev.clientX, ev.clientY);
});

touchEl.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') {
    input.send({ t: 'btn', b: mouseButton(e), d: false });
    return;
  }
  gestures.pointerUp(e.pointerId, e.clientX, e.clientY);
});

touchEl.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'mouse') input.send({ t: 'release' });
  else gestures.pointerCancel(e.pointerId);
});

touchEl.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const fb = toFb(e.clientX, e.clientY);
    if (!fb) return;
    input.send({ t: 'move', x: fb.x, y: fb.y });
    input.send({ t: 'wheel', dir: e.deltaY < 0 ? 'up' : 'down' });
  },
  { passive: false },
);

touchEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------- toolbar

const keyboard = new Keyboard($('#kbd'), (msg) => input.send(msg));
const toolbar = $('#toolbar');
const modifiers = { Shift_L: false, Control_L: false };

function setMenuButton(on) {
  gestures.setMenuMode(on);
  $('#btn-menu').setAttribute('aria-pressed', String(on));
}

function bindButton(id, handler) {
  const el = $(id);
  // pointerdown keeps the text field focused (and the phone keyboard open).
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('click', handler);
}

const COLLAPSED_KEY = 'rlweb.toolbarCollapsed';
try {
  toolbar.classList.toggle('collapsed', localStorage.getItem(COLLAPSED_KEY) === '1');
} catch {
  // Storage unavailable: start expanded.
}
bindButton('#btn-collapse', () => {
  const collapsed = toolbar.classList.toggle('collapsed');
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Not remembered; harmless.
  }
});
bindButton('#btn-kbd', () => keyboard.toggle());
bindButton('#btn-menu', (e) => setMenuButton(e.currentTarget.getAttribute('aria-pressed') !== 'true'));
for (const [id, keysym] of [
  ['#btn-shift', 'Shift_L'],
  ['#btn-ctrl', 'Control_L'],
]) {
  bindButton(id, (e) => {
    modifiers[keysym] = !modifiers[keysym];
    e.currentTarget.setAttribute('aria-pressed', String(modifiers[keysym]));
    input.send({ t: 'key', k: keysym, d: modifiers[keysym] });
  });
}
bindButton('#btn-esc', () => keyboard.tap('Escape'));
bindButton('#btn-fkeys', () => {
  settings.showFKeys = !settings.showFKeys;
  applySettings();
});
bindButton('#btn-fullscreen', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
});
bindButton('#btn-settings', () => openSettings());

const fkeys = $('#fkeys');
for (let i = 1; i <= 12; i++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `F${i}`;
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('click', () => keyboard.tap(`F${i}`));
  fkeys.append(b);
}

// ------------------------------------------------------------------ settings

const dialog = $('#settings');
const form = $('#settings-form');
const profileSelect = $('#profile-select');

function applySettings() {
  gestures.updateSettings(settings);
  document.body.dataset.toolbarSide = settings.toolbarSide;
  fkeys.hidden = !settings.showFKeys;
  $('#btn-fkeys').setAttribute('aria-pressed', String(settings.showFKeys));
  if (rfb) rfb.qualityLevel = settings.quality;
  layoutScreen();
}

function fillProfileSelect() {
  profileSelect.replaceChildren(
    ...profiles.names.map((name) => new Option(name, name, false, name === profiles.activeName)),
  );
}

function fillForm(values) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in values)) continue;
    if (el.type === 'checkbox') el.checked = values[el.name];
    else el.value = values[el.name];
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function readForm() {
  const out = { ...settings };
  for (const el of form.elements) {
    if (!el.name || !(el.name in PROFILE_DEFAULTS)) continue;
    out[el.name] =
      el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value;
  }
  return out;
}

function openSettings() {
  fillProfileSelect();
  fillForm(settings);
  dialog.showModal();
}

form.addEventListener('input', (e) => {
  const out = e.target.closest('label')?.querySelector('output');
  if (out) out.textContent = e.target.value;
});

profileSelect.addEventListener('change', () => {
  profiles.activeName = profileSelect.value;
  settings = profiles.active;
  fillForm(settings);
  applySettings();
});

$('#profile-new').addEventListener('click', async () => {
  const name = prompt('New profile name', 'Mobile')?.trim();
  if (!name) return;
  await profiles.save(name, readForm());
  fillProfileSelect();
});

$('#profile-delete').addEventListener('click', async () => {
  if (!confirm(`Delete profile "${profiles.activeName}"?`)) return;
  await profiles.remove(profiles.activeName);
  settings = profiles.active;
  fillProfileSelect();
  fillForm(settings);
  applySettings();
});

$('#settings-save').addEventListener('click', async () => {
  settings = readForm();
  applySettings();
  try {
    await profiles.save(profiles.activeName, settings);
    dialog.close();
  } catch (err) {
    alert(err.message);
  }
});

$('#settings-export').addEventListener('click', () => {
  const blob = new Blob([profiles.exportJson()], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'runelite-web-profiles.json',
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#settings-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await profiles.importJson(await file.text());
    fillProfileSelect();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

$('#runelite-restart').addEventListener('click', async () => {
  if (!confirm('Restart RuneLite? You will be logged out of the game.')) return;
  const res = await fetch('api/runelite/restart', { method: 'POST' });
  if (!res.ok) alert(await res.text());
  dialog.close();
});

// --------------------------------------------------------------------- start

function releaseAll() {
  input.send({ t: 'release' });
  for (const [id, keysym] of [
    ['#btn-shift', 'Shift_L'],
    ['#btn-ctrl', 'Control_L'],
  ]) {
    modifiers[keysym] = false;
    $(id).setAttribute('aria-pressed', 'false');
  }
}

window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAll();
});

await profiles.load();
settings = profiles.active;
applySettings();
connectVideo();
