"""Injects mouse and keyboard input into the X display through the XTEST extension.

This is the same mechanism a remote-desktop server uses: RuneLite sees ordinary
pointer and key events coming from the X server and is not modified in any way.
"""

import logging

from Xlib import X, XK, display
from Xlib.ext import xtest

log = logging.getLogger(__name__)

BUTTONS = {1, 2, 3}
WHEEL_BUTTONS = {"up": 4, "down": 5}

# Characters whose X keysym name differs from what string_to_keysym expects.
CHAR_KEYSYMS = {
    "\n": XK.XK_Return,
    "\r": XK.XK_Return,
    "\t": XK.XK_Tab,
    " ": XK.XK_space,
}


def char_to_keysym(char):
    """Returns the X keysym for a single character."""
    if char in CHAR_KEYSYMS:
        return CHAR_KEYSYMS[char]
    code = ord(char)
    # Latin-1 keysyms are numerically equal to their code points.
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    return 0x01000000 + code


class XInput:
    def __init__(self, display_name=None):
        self._display = display.Display(display_name)
        if not self._display.has_extension("XTEST"):
            raise RuntimeError("X server has no XTEST extension")
        self._held_buttons = set()
        self._held_keycodes = set()
        self._shift_keycode = self._display.keysym_to_keycode(XK.XK_Shift_L)

    def screen_size(self):
        root = self._display.screen().root
        geometry = root.get_geometry()
        return geometry.width, geometry.height

    def move(self, x, y):
        width, height = self.screen_size()
        x = max(0, min(int(x), width - 1))
        y = max(0, min(int(y), height - 1))
        xtest.fake_input(self._display, X.MotionNotify, x=x, y=y)
        self._display.flush()

    def button(self, button, down):
        if button not in BUTTONS:
            raise ValueError(f"unsupported button {button!r}")
        if down == (button in self._held_buttons):
            return
        xtest.fake_input(self._display, X.ButtonPress if down else X.ButtonRelease, button)
        (self._held_buttons.add if down else self._held_buttons.discard)(button)
        self._display.flush()

    def wheel(self, direction):
        button = WHEEL_BUTTONS[direction]
        xtest.fake_input(self._display, X.ButtonPress, button)
        xtest.fake_input(self._display, X.ButtonRelease, button)
        self._display.flush()

    def key(self, keysym_name, down):
        keysym = XK.string_to_keysym(keysym_name)
        if not keysym:
            raise ValueError(f"unknown keysym {keysym_name!r}")
        keycode = self._display.keysym_to_keycode(keysym)
        if not keycode:
            raise ValueError(f"no keycode for keysym {keysym_name!r}")
        if down == (keycode in self._held_keycodes):
            return
        xtest.fake_input(self._display, X.KeyPress if down else X.KeyRelease, keycode)
        (self._held_keycodes.add if down else self._held_keycodes.discard)(keycode)
        self._display.flush()

    def type_text(self, text):
        for char in text:
            keysym = char_to_keysym(char)
            keycode = self._display.keysym_to_keycode(keysym)
            if not keycode:
                log.debug("no keycode for %r, skipping", char)
                continue
            needs_shift = (
                self._display.keycode_to_keysym(keycode, 0) != keysym
                and self._display.keycode_to_keysym(keycode, 1) == keysym
                and self._shift_keycode not in self._held_keycodes
            )
            if needs_shift:
                xtest.fake_input(self._display, X.KeyPress, self._shift_keycode)
            xtest.fake_input(self._display, X.KeyPress, keycode)
            xtest.fake_input(self._display, X.KeyRelease, keycode)
            if needs_shift:
                xtest.fake_input(self._display, X.KeyRelease, self._shift_keycode)
        self._display.flush()

    def release_all(self):
        """Releases every button and key this client is holding, e.g. on disconnect."""
        for button in list(self._held_buttons):
            xtest.fake_input(self._display, X.ButtonRelease, button)
        for keycode in list(self._held_keycodes):
            xtest.fake_input(self._display, X.KeyRelease, keycode)
        self._held_buttons.clear()
        self._held_keycodes.clear()
        self._display.flush()

    def close(self):
        self.release_all()
        self._display.close()
