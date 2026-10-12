// Turns touch pointer events into mouse input, following the official OSRS
// mobile client's conventions. Every gesture maps to the input a person would
// make with a real mouse: one tap is one click, with no repeats or macros.
//
//   tap                      -> left-click
//   long-press, release      -> right-click (opens the menu)
//   long-press, then drag    -> left-button drag (move inventory/bank items)
//   drag                     -> middle-button drag (rotate/tilt the camera)
//   pinch                    -> mouse wheel (zoom)
//   two-finger vertical drag -> mouse wheel (scroll lists and panels)
//
// The engine is DOM-free so it can be unit tested. Coordinates passed in are
// client (CSS pixel) coordinates; toFb maps them to the remote framebuffer.

export const GESTURE_DEFAULTS = Object.freeze({
  longPressMs: 450,
  tapSlopPx: 12,
  dragSensitivity: 1.0,
  pinchStepPx: 40,
  scrollStepPx: 32,
});

const State = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending', // one finger down, not yet a tap, hold or drag
  HELD: 'held', // long-press timer fired, finger has not moved
  CAMERA_DRAG: 'cameraDrag',
  ITEM_DRAG: 'itemDrag',
  TWO_FINGER: 'twoFinger',
  ENDING: 'ending', // multi-touch gesture ending; ignore until all fingers lift
});

export class GestureEngine {
  /**
   * @param {object} opts
   * @param {(action: object) => void} opts.emit receives {t:'move',x,y}, {t:'btn',b,d}, {t:'wheel',dir}
   * @param {(cx: number, cy: number) => {x:number,y:number,w:number,h:number}|null} opts.toFb
   * @param {(event: string, info?: object) => void} [opts.feedback] UI hooks: 'longpress', 'tap', 'end'
   * @param {object} [opts.settings]
   * @param {Function} [opts.setTimer] defaults to setTimeout
   * @param {Function} [opts.clearTimer] defaults to clearTimeout
   */
  constructor({ emit, toFb, feedback = () => {}, settings = {}, setTimer, clearTimer }) {
    this.emit = emit;
    this.toFb = toFb;
    this.feedback = feedback;
    this.settings = { ...GESTURE_DEFAULTS, ...settings };
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = clearTimer || ((id) => clearTimeout(id));
    this.menuMode = false;
    this.reset();
  }

  updateSettings(settings) {
    this.settings = { ...GESTURE_DEFAULTS, ...settings };
  }

  /** The next tap becomes a right-click (the mobile client's menu toggle). */
  setMenuMode(on) {
    this.menuMode = Boolean(on);
  }

  reset() {
    this.state = State.IDLE;
    this.pointers = new Map();
    this.origin = null;
    this.originFb = null;
    this.lastFb = null;
    this.wheelMode = null;
    this.wheelAcc = 0;
    this.cancelTimer();
  }

  pointerDown(id, cx, cy) {
    this.pointers.set(id, { cx, cy, startX: cx, startY: cy });
    if (this.pointers.size === 1 && this.state === State.IDLE) {
      const fb = this.toFb(cx, cy);
      if (!fb) {
        this.pointers.delete(id);
        return;
      }
      this.state = State.PENDING;
      this.origin = { cx, cy };
      this.originFb = fb;
      this.timer = this.setTimer(() => this.onLongPress(), this.settings.longPressMs);
      return;
    }
    if (this.pointers.size === 2 && this.state !== State.ENDING) {
      this.endSingleFinger();
      this.startTwoFinger();
      return;
    }
    // A third finger, or a finger during ENDING, cancels whatever was happening.
    this.endSingleFinger();
    this.state = State.ENDING;
  }

  pointerMove(id, cx, cy) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.cx = cx;
    p.cy = cy;
    switch (this.state) {
      case State.PENDING:
        if (this.beyondSlop(cx, cy)) {
          this.cancelTimer();
          this.state = State.CAMERA_DRAG;
          this.emit({ t: 'move', x: this.originFb.x, y: this.originFb.y });
          this.emit({ t: 'btn', b: 2, d: true });
          this.dragTo(cx, cy, this.settings.dragSensitivity);
        }
        break;
      case State.HELD:
        if (this.beyondSlop(cx, cy)) {
          this.state = State.ITEM_DRAG;
          this.emit({ t: 'move', x: this.originFb.x, y: this.originFb.y });
          this.emit({ t: 'btn', b: 1, d: true });
          this.dragTo(cx, cy, 1);
        }
        break;
      case State.CAMERA_DRAG:
        this.dragTo(cx, cy, this.settings.dragSensitivity);
        break;
      case State.ITEM_DRAG:
        this.dragTo(cx, cy, 1);
        break;
      case State.TWO_FINGER:
        this.twoFingerMove();
        break;
      default:
        break;
    }
  }

  pointerUp(id, cx, cy) {
    if (!this.pointers.has(id)) return;
    this.pointerMove(id, cx, cy);
    this.pointers.delete(id);
    switch (this.state) {
      case State.PENDING:
        this.cancelTimer();
        this.click(this.menuMode ? 3 : 1);
        this.feedback('tap', { cx: this.origin.cx, cy: this.origin.cy, right: this.menuMode });
        this.menuMode = false;
        break;
      case State.HELD:
        this.click(3);
        break;
      case State.CAMERA_DRAG:
        this.emit({ t: 'btn', b: 2, d: false });
        break;
      case State.ITEM_DRAG:
        this.emit({ t: 'btn', b: 1, d: false });
        break;
      case State.TWO_FINGER:
        this.state = State.ENDING;
        break;
      default:
        break;
    }
    if (this.pointers.size === 0) {
      this.feedback('end');
      this.reset();
    } else if (this.state !== State.ENDING) {
      this.state = State.ENDING;
    }
  }

  pointerCancel(id) {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    this.endSingleFinger();
    if (this.pointers.size === 0) {
      this.feedback('end');
      this.reset();
    } else {
      this.state = State.ENDING;
    }
  }

  // --- internals ---

  onLongPress() {
    this.timer = null;
    if (this.state !== State.PENDING) return;
    this.state = State.HELD;
    this.feedback('longpress', { cx: this.origin.cx, cy: this.origin.cy });
  }

  cancelTimer() {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  beyondSlop(cx, cy) {
    return Math.hypot(cx - this.origin.cx, cy - this.origin.cy) > this.settings.tapSlopPx;
  }

  click(button) {
    this.emit({ t: 'move', x: this.originFb.x, y: this.originFb.y });
    this.emit({ t: 'btn', b: button, d: true });
    this.emit({ t: 'btn', b: button, d: false });
  }

  /** Moves the remote pointer by the finger's travel since touch-down, scaled. */
  dragTo(cx, cy, scale) {
    const now = this.toFb(cx, cy, { clamp: true });
    const start = this.originFb;
    const x = clamp(Math.round(start.x + (now.x - start.x) * scale), 0, start.w - 1);
    const y = clamp(Math.round(start.y + (now.y - start.y) * scale), 0, start.h - 1);
    if (this.lastFb && this.lastFb.x === x && this.lastFb.y === y) return;
    this.lastFb = { x, y };
    this.emit({ t: 'move', x, y });
  }

  /** Releases any button held by a single-finger gesture. */
  endSingleFinger() {
    this.cancelTimer();
    if (this.state === State.CAMERA_DRAG) this.emit({ t: 'btn', b: 2, d: false });
    if (this.state === State.ITEM_DRAG) this.emit({ t: 'btn', b: 1, d: false });
  }

  startTwoFinger() {
    this.state = State.TWO_FINGER;
    const [a, b] = [...this.pointers.values()];
    this.twoStart = { dist: distance(a, b), cy: (a.cy + b.cy) / 2 };
    this.wheelMode = null;
    this.wheelAcc = 0;
    this.wheelPositioned = false;
  }

  twoFingerMove() {
    const [a, b] = [...this.pointers.values()];
    const dist = distance(a, b);
    const cy = (a.cy + b.cy) / 2;
    const { pinchStepPx, scrollStepPx } = this.settings;
    if (!this.wheelMode) {
      const pinch = Math.abs(dist - this.twoStart.dist);
      const pan = Math.abs(cy - this.twoStart.cy);
      if (pinch < pinchStepPx / 2 && pan < scrollStepPx / 2) return;
      this.wheelMode = pinch >= pan ? 'pinch' : 'scroll';
      this.wheelBase = this.wheelMode === 'pinch' ? this.twoStart.dist : this.twoStart.cy;
    }
    if (!this.wheelPositioned) {
      const center = this.toFb((a.cx + b.cx) / 2, cy, { clamp: true });
      this.emit({ t: 'move', x: center.x, y: center.y });
      this.wheelPositioned = true;
    }
    // Spreading the fingers zooms in (wheel up). Moving them up scrolls the
    // content down (wheel down), like natural scrolling on a phone.
    const travel = this.wheelMode === 'pinch' ? dist - this.wheelBase : this.wheelBase - cy;
    const step = this.wheelMode === 'pinch' ? pinchStepPx : scrollStepPx;
    const notches = Math.trunc(travel / step);
    if (notches === 0) return;
    const dir = (this.wheelMode === 'pinch') === notches > 0 ? 'up' : 'down';
    for (let i = 0; i < Math.abs(notches); i++) this.emit({ t: 'wheel', dir });
    this.wheelBase += (this.wheelMode === 'pinch' ? 1 : -1) * notches * step;
  }
}

function distance(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
