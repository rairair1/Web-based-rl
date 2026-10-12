// Keyboard input: the phone's on-screen keyboard (through a hidden text field)
// and physical keyboards on tablets and handhelds.

// Keys that don't produce text, mapped from KeyboardEvent.key to X keysym names.
const SPECIAL_KEYS = {
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
  Delete: 'Delete',
  Insert: 'Insert',
};
for (let i = 1; i <= 12; i++) SPECIAL_KEYS[`F${i}`] = `F${i}`;

// The hidden field always holds this text, so a backspace on an "empty" field
// still produces an input event we can see.
const SENTINEL = '  ';

export class Keyboard {
  /**
   * @param {HTMLInputElement} field hidden text field that summons the phone's keyboard
   * @param {(msg: object) => void} send
   */
  constructor(field, send) {
    this.field = field;
    this.send = send;
    this.composing = false;
    this.resetField();

    field.addEventListener('keydown', (e) => this.onKeyDown(e, true));
    field.addEventListener('compositionstart', () => (this.composing = true));
    field.addEventListener('compositionend', () => {
      this.composing = false;
      this.flushField();
    });
    field.addEventListener('input', () => {
      if (!this.composing) this.flushField();
    });
    field.addEventListener('blur', () => this.resetField());
    document.addEventListener('keydown', (e) => {
      if (e.target !== field && !isEditable(e.target)) this.onKeyDown(e, false);
    });
    document.addEventListener('keyup', (e) => {
      const keysym = SPECIAL_KEYS[e.key];
      if (keysym && !isEditable(e.target)) this.send({ t: 'key', k: keysym, d: false });
    });
  }

  get visible() {
    return document.activeElement === this.field;
  }

  toggle() {
    if (this.visible) this.field.blur();
    else this.field.focus({ preventScroll: true });
  }

  /** Sends a key press and release, e.g. from the F-key bar. */
  tap(keysym) {
    this.send({ t: 'key', k: keysym, d: true });
    this.send({ t: 'key', k: keysym, d: false });
  }

  onKeyDown(e, fromField) {
    if (e.isComposing || e.keyCode === 229) return;
    const keysym = SPECIAL_KEYS[e.key];
    if (keysym) {
      e.preventDefault();
      if (e.repeat) return;
      this.send({ t: 'key', k: keysym, d: true });
      // Text field keyup is unreliable on mobile; release immediately there.
      if (fromField) this.send({ t: 'key', k: keysym, d: false });
      return;
    }
    if (fromField) return; // Text and backspace arrive through the input event.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Backspace') {
      e.preventDefault();
      this.tap('BackSpace');
    } else if (e.key.length === 1) {
      e.preventDefault();
      this.send({ t: 'text', s: e.key });
    }
  }

  flushField() {
    const value = this.field.value;
    if (value.startsWith(SENTINEL)) {
      const added = value.slice(SENTINEL.length);
      if (added) this.send({ t: 'text', s: added });
    } else {
      const deleted = Math.max(1, SENTINEL.length - value.length);
      for (let i = 0; i < deleted; i++) this.tap('BackSpace');
    }
    this.resetField();
  }

  resetField() {
    this.field.value = SENTINEL;
    try {
      this.field.setSelectionRange(SENTINEL.length, SENTINEL.length);
    } catch {
      // Not focusable yet.
    }
  }
}

function isEditable(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
