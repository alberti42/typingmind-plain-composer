# TypingMind Plain Text Composer (userscript)

A lightweight userscript for **TypingMind** that replaces the native rich composer with a **plain `<textarea>` overlay** for **smoother typing** — especially in long chats where the DOM becomes heavy and the native composer starts lagging.

---

## Why this exists

TypingMind’s original message composer is feature-rich and integrates deeply with the app UI.  
However, in long conversations (or when the chat DOM becomes complex), typing can become **noticeably laggy**, including:

- long input latency (characters appear late)
- dropped keystrokes
- slow cursor movement
- pauses while the app rerenders
- worse behavior on lower-end laptops or when many tabs are open

This usually happens because the original composer is tied to a React/Tailwind UI layer and may trigger expensive DOM work and layout/paint operations while typing, especially when the page is also updating message history, toolbars, animations, etc.

---

## What this script does

This userscript provides a **plain text input overlay** that:

✅ feels like typing into a native text editor  
✅ avoids the heavy composer DOM and rerender pipeline  
✅ still sends messages through TypingMind normally (it copies text into the real textarea and triggers send)  
✅ keeps your drafts (per chat URL)  
✅ supports autogrow  
✅ supports a toggle to temporarily bring back the original composer  
✅ avoids “jitter” during TypingMind hydration by waiting for stable layout before showing

---

## Screenshot

![TypingMind Plain Text Composer](typingmind-plain-composer.png)

---

## Features

- **Plain textarea overlay** for fast input
- **Autogrow** (up to a percentage of the viewport height)
- **Per-chat drafts** saved to `localStorage`
- **Draft cleanup** with TTL + maximum entries
- **Ctrl/Cmd + Enter to send**
- **Esc** toggles the original TypingMind composer
- **“Plain Composer” floating button** appears when the original composer is shown
- **Stable anchoring**:
  - Composer stays centered with the TypingMind chat column
  - No bouncing during load / React hydration
- **Throttled MutationObserver** for SPA rerenders

---

## Installation

### 1) Install ViolentMonkey
- Chrome / Chromium browsers: install **ViolentMonkey** extension
- Firefox: install **ViolentMonkey** add-on

### 2) Install the script
1. Open ViolentMonkey dashboard
2. Click **New Script**
3. Paste the content of `typingmind-plain-composer.user.js`
4. Save

### 3) Open TypingMind
Go to:
- https://typingmind.com  
or
- https://www.typingmind.com

The plain composer should appear once TypingMind has fully loaded and its layout has stabilized.

---

## Usage

### Typing
- Just type normally in the overlay textarea.
- Drafts are saved automatically (per chat URL).

### Sending
- Press **Ctrl+Enter** (Windows/Linux) or **Cmd+Enter** (macOS)
- Or click **Send**

### Toggling the original composer
- Press **Esc**, or click **Toggle Original**
- When the original is visible, a floating button appears:
  - **Plain Composer** → return to overlay

---

## How it works (high level)

TypingMind’s native composer remains in the DOM, but the script:

1. Waits until the native composer becomes visible at least once (hydration complete)
2. Measures the chat column geometry (`<main>` / scroll container) and the native input container width
3. Creates an overlay textarea
4. Anchors the overlay to the same horizontal region as the chat column
5. Hides the original textarea (optional / default)
6. On send, copies the overlay text into the real TypingMind textarea and triggers send using a sequence of strategies:
   - Ctrl+Enter
   - Cmd+Enter
   - Enter
   - Send button click fallback

To prevent the overlay from “moving around” during initial React hydration, the overlay only becomes visible once the page layout is stable for several consecutive checks.

---

## Configuration

Most settings can be tweaked inside the script in the `CONFIG` object:

- maximum width cap (fallback)
- autogrow min height and max viewport height
- draft retention (TTL, max entries)
- debounce timings
- mutation observer throttling
- send strategy preferences
- stability gating settings

---

# Compatibility

## Userscript

This script is written as a **standard userscript** and does not rely on any special Userscript Manager APIs (`@grant none`).  
As a result, it should work in most common userscript managers:

* ✅ **ViolentMonkey** (tested)
* ✅ **Tampermonkey** (expected to work)
* ✅ **Greasemonkey** (expected to work; Firefox)
* ✅ **Safari Userscripts** (tested)

##  TypingMind

* Since TypingMind is a **single-page app (SPA)**, the script uses a MutationObserver + periodic checks to reattach after rerenders.
* Some browsers/userscript managers may handle **synthetic keyboard events** differently. The script includes multiple send strategies (Ctrl/Cmd+Enter, Enter, and a send button click fallback) to maximize compatibility.
* If you encounter issues, please open an issue and include:
    * browser + version
    * userscript manager + version
    * whether sending works via hotkey vs. send button
    * console logs starting with `[TMPlainComposer]`

---

## Troubleshooting

### The overlay does not show up
- Make sure the script is enabled in ViolentMonkey.
- Hard refresh TypingMind (Ctrl+Shift+R / Cmd+Shift+R).
- Open DevTools → Console and look for logs starting with:
  - `[TMPlainComposer]`

### Sending doesn’t work
TypingMind setups may differ (Enter-to-send vs Ctrl+Enter).  
You can adjust the send strategy options in the script:

- `trySendViaCtrlEnter`
- `trySendViaMetaEnter`
- `trySendViaPlainEnter`
- `trySendViaSendButton`

---

## Contributing

PRs and improvements are welcome!

If TypingMind changes their DOM and this script breaks, please open an issue with:
- TypingMind version (if known)
- screenshots of the composer area
- the HTML snippet around the composer (`#chat-input-textbox`)
- console logs

---

## License

MIT (or choose your preferred license).
