// Touch and display profiles. Profiles are stored on the host so every device
// sees the same list. Which profile a device uses is remembered per device.

import { GESTURE_DEFAULTS } from './gestures.js';

export const PROFILE_DEFAULTS = Object.freeze({
  ...GESTURE_DEFAULTS,
  displayMode: 'resize', // 'resize': RuneLite's window follows the screen; 'fit': scale a fixed desktop
  resolutionScale: 1.5, // remote pixels per CSS pixel in 'resize' mode
  quality: 6, // noVNC JPEG quality, 0-9
  toolbarSide: 'left',
  haptics: true,
  showFKeys: false,
});

const ACTIVE_KEY = 'rlweb.activeProfile';
const CACHE_KEY = 'rlweb.profilesCache';
const DEFAULT_NAME = 'Default';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: the host copy is still authoritative.
  }
}

export class ProfileStore {
  constructor(fetchImpl = (...args) => fetch(...args)) {
    this.fetch = fetchImpl;
    this.doc = { version: 1, profiles: {} };
  }

  async load() {
    try {
      const res = await this.fetch('api/profiles', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.doc = await res.json();
      storageSet(CACHE_KEY, JSON.stringify(this.doc));
    } catch (err) {
      const cached = storageGet(CACHE_KEY);
      if (cached) this.doc = JSON.parse(cached);
      console.warn('Using cached profiles:', err);
    }
    if (!this.doc.profiles || typeof this.doc.profiles !== 'object') this.doc.profiles = {};
    if (Object.keys(this.doc.profiles).length === 0) this.doc.profiles[DEFAULT_NAME] = {};
    if (!this.doc.profiles[this.activeName]) this.activeName = Object.keys(this.doc.profiles)[0];
  }

  get names() {
    return Object.keys(this.doc.profiles).sort();
  }

  get activeName() {
    return storageGet(ACTIVE_KEY) || DEFAULT_NAME;
  }

  set activeName(name) {
    storageSet(ACTIVE_KEY, name);
  }

  get active() {
    return { ...PROFILE_DEFAULTS, ...this.doc.profiles[this.activeName] };
  }

  async save(name, settings) {
    this.doc.profiles[name] = sanitize(settings);
    this.activeName = name;
    await this.persist();
  }

  async remove(name) {
    delete this.doc.profiles[name];
    if (Object.keys(this.doc.profiles).length === 0) this.doc.profiles[DEFAULT_NAME] = {};
    if (this.activeName === name) this.activeName = this.names[0];
    await this.persist();
  }

  exportJson() {
    return JSON.stringify(this.doc, null, 2);
  }

  async importJson(text) {
    const doc = JSON.parse(text);
    if (!doc || typeof doc.profiles !== 'object') throw new Error('Not a profiles file');
    for (const [name, settings] of Object.entries(doc.profiles)) {
      this.doc.profiles[name] = sanitize(settings);
    }
    await this.persist();
  }

  async persist() {
    storageSet(CACHE_KEY, JSON.stringify(this.doc));
    const res = await this.fetch('api/profiles', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.doc),
    });
    if (!res.ok) throw new Error(`Saving profiles failed: HTTP ${res.status}`);
  }
}

/** Keeps only known settings, with the default's type. */
export function sanitize(settings) {
  const out = {};
  for (const [key, def] of Object.entries(PROFILE_DEFAULTS)) {
    if (!(key in settings)) continue;
    const value = settings[key];
    if (typeof def === 'number' && Number.isFinite(Number(value))) out[key] = Number(value);
    else if (typeof def === 'boolean') out[key] = Boolean(value);
    else if (typeof def === 'string' && typeof value === 'string') out[key] = value;
  }
  return out;
}
