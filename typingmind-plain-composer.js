// ==UserScript==
// @name         TypingMind Plain Text Composer (Hide Original)
// @namespace    vm-typingmind-plain-composer
// @version      1.0
// @description  Replace TypingMind input with a plain textarea overlay for smoother typing. Adds autogrow + drafts + cleanup + throttled MutationObserver + non-overlapping toggle UX.
// @match        https://www.typingmind.com/*
// @match        https://typingmind.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---- Config ----
  const CONFIG = {
    textareaWidth: "720px",

    // Autogrow behavior
    minHeightPx: 30,
    maxHeightVh: 35,

    fontSize: "15px",
    lineHeight: "1.4",

    // If true we hide the real TypingMind textarea when in plain mode
    hideOriginalComposer: true,

    // Draft persistence
    persistDrafts: true,
    clearDraftOnSend: true,
    draftSaveDebounceMs: 250,

    // Cleanup / retention
    draftTtlDays: 30,
    maxDraftEntries: 200,

    // Hotkeys
    sendHotkeyRequiresCtrlOrCmd: true, // Ctrl/Cmd+Enter sends, Enter inserts newline

    // MutationObserver throttling
    mutationThrottleMs: 200,

    // Toggle UX (avoid overlap)
    hidePlainComposerWhenOriginalShown: true,
    showReturnButtonWhenOriginalShown: true,

    // Sending strategy
    // Try these in order:
    trySendViaCtrlEnter: true,
    trySendViaMetaEnter: true,
    trySendViaPlainEnter: true, // some TypingMind setups send with Enter
    trySendViaSendButton: true,
  };

  const STATE = {
    installedUI: false,

    wrapperEl: null,
    textareaEl: null,

    returnBtnEl: null,
    originalVisibleByUser: false,

    lastKnownRealTextarea: null,

    draftKey: null,
    saveTimer: null,
    lastSavedValue: null,
    cleanedThisSession: false,
  };

  // ---- Helpers ----
  function log(...args) {
    console.log("[TMPlainComposer]", ...args);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function nowMs() {
    return Date.now();
  }

  // ---- TypingMind selectors ----
  function getRealTextarea() {
    return (
      qs("textarea#chat-input-textbox") ||
      qs('textarea[data-element-id="chat-input-textbox"]') ||
      qs("textarea.main-chat-input") ||
      null
    );
  }

  function getSendButtonCandidate() {
    // TypingMind changes its send button markup. We attempt a few heuristics.
    // If none found, we rely on key events.
    const candidates = []
      .concat(qsa('button[data-element-id*="send"]'))
      .concat(qsa('button[aria-label*="Send"]'))
      .concat(qsa('button[title*="Send"]'));

    // Choose first enabled
    return candidates.find((b) => !b.disabled) || null;
  }

  function hideRealTextarea(real) {
    if (!real) return;
    if (real.dataset.tmPlainHidden) return;

    real.dataset.tmPlainHidden = "1";
    real.style.display = "none";
  }

  function showRealTextarea(real) {
    if (!real) return;
    if (!real.dataset.tmPlainHidden) return;

    delete real.dataset.tmPlainHidden;
    real.style.display = "";
  }

  // ---- Drafts ----
  function getChatKeyFromUrl() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function computeDraftKey() {
    return `vm_tm_plain_composer_draft:${location.host}:${getChatKeyFromUrl()}`;
  }

  function ttlMs() {
    return CONFIG.draftTtlDays * 24 * 60 * 60 * 1000;
  }

  function isOurDraftKey(key) {
    return typeof key === "string" && key.startsWith("vm_tm_plain_composer_draft:");
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function cleanupOldDraftsOncePerSession() {
    if (!CONFIG.persistDrafts) return;
    if (STATE.cleanedThisSession) return;

    STATE.cleanedThisSession = true;

    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isOurDraftKey(k)) keys.push(k);
    }

    const entries = [];
    const cutoff = nowMs() - ttlMs();

    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;

      const obj = safeJsonParse(raw);
      if (!obj || typeof obj !== "object") {
        try { localStorage.removeItem(k); } catch {}
        continue;
      }

      const ts = Number(obj.ts);
      const text = typeof obj.text === "string" ? obj.text : "";

      if (!ts || ts < cutoff || text.length === 0) {
        try { localStorage.removeItem(k); } catch {}
        continue;
      }

      entries.push({ key: k, ts });
    }

    if (entries.length > CONFIG.maxDraftEntries) {
      entries.sort((a, b) => b.ts - a.ts);
      const toRemove = entries.slice(CONFIG.maxDraftEntries);
      for (const e of toRemove) {
        try { localStorage.removeItem(e.key); } catch {}
      }
    }
  }

  function loadDraftIfAny() {
    if (!CONFIG.persistDrafts || !STATE.textareaEl) return;

    cleanupOldDraftsOncePerSession();

    const key = computeDraftKey();
    STATE.draftKey = key;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;

      const obj = safeJsonParse(raw);
      if (obj && typeof obj.text === "string" && obj.text.length > 0) {
        STATE.textareaEl.value = obj.text;
        STATE.lastSavedValue = obj.text;
        autogrow(STATE.textareaEl);
      }
    } catch (e) {
      log("Draft load failed:", e);
    }
  }

  function saveDraftDebounced() {
    if (!CONFIG.persistDrafts || !STATE.textareaEl) return;
    if (!STATE.draftKey) STATE.draftKey = computeDraftKey();

    const val = STATE.textareaEl.value;
    if (val === STATE.lastSavedValue) return;

    if (STATE.saveTimer) clearTimeout(STATE.saveTimer);

    STATE.saveTimer = setTimeout(() => {
      try {
        const payload = JSON.stringify({ text: val, ts: nowMs() });
        localStorage.setItem(STATE.draftKey, payload);
        STATE.lastSavedValue = val;
      } catch (e) {
        log("Draft save failed:", e);
      }
    }, CONFIG.draftSaveDebounceMs);
  }

  function clearDraft() {
    if (!CONFIG.persistDrafts) return;
    if (!STATE.draftKey) return;

    try {
      localStorage.removeItem(STATE.draftKey);
      STATE.lastSavedValue = "";
    } catch (e) {
      log("Draft clear failed:", e);
    }
  }

  // ---- Autogrow ----
  function autogrow(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxPx = Math.round((window.innerHeight * CONFIG.maxHeightVh) / 100);
    const newPx = Math.min(Math.max(textarea.scrollHeight, CONFIG.minHeightPx), maxPx);
    textarea.style.height = `${newPx}px`;
  }

  // ---- UI (same look as ChatGPT version) ----
  function styleButton(btn) {
    btn.style.border = "1px solid rgba(255,255,255,0.2)";
    btn.style.borderRadius = "8px";
    btn.style.padding = "8px 10px";
    btn.style.cursor = "pointer";
    btn.style.background = "rgba(255,255,255,0.10)";
    btn.style.color = "#fff";
    btn.style.fontSize = "13px";
    btn.style.userSelect = "none";
  }

  function setPlainComposerVisible(visible) {
    if (!STATE.wrapperEl) return;
    STATE.wrapperEl.style.display = visible ? "flex" : "none";
  }

  function ensureReturnButton() {
    if (!CONFIG.showReturnButtonWhenOriginalShown) return;
    if (STATE.returnBtnEl) return STATE.returnBtnEl;

    const btn = document.createElement("button");
    btn.id = "vm-tm-plain-composer-return-btn";
    btn.textContent = "Plain Composer";
    btn.title = "Return to the plain composer overlay";

    btn.style.position = "fixed";
    btn.style.right = "14px";
    btn.style.bottom = "14px";
    btn.style.zIndex = "2147483647";
    btn.style.border = "1px solid rgba(255,255,255,0.25)";
    btn.style.borderRadius = "999px";
    btn.style.padding = "8px 12px";
    btn.style.cursor = "pointer";
    btn.style.background = "rgba(20,20,20,0.85)";
    btn.style.color = "#fff";
    btn.style.fontSize = "13px";
    btn.style.boxShadow = "0 10px 28px rgba(0,0,0,0.35)";
    btn.style.backdropFilter = "blur(6px)";
    btn.style.display = "none";

    btn.addEventListener("click", () => {
      STATE.originalVisibleByUser = false;

      const real = getRealTextarea();
      if (real && CONFIG.hideOriginalComposer) {
        hideRealTextarea(real);
      }

      btn.style.display = "none";
      setPlainComposerVisible(true);

      if (STATE.textareaEl) STATE.textareaEl.focus();
    });

    // append to documentElement early (document-start safe)
    document.documentElement.appendChild(btn);
    STATE.returnBtnEl = btn;
    return btn;
  }

  function showReturnButton(show) {
    const btn = ensureReturnButton();
    if (!btn) return;
    btn.style.display = show ? "block" : "none";
  }

  function createPlainComposerUI() {
    if (STATE.installedUI) return;
    STATE.installedUI = true;

    const wrapper = document.createElement("div");
    wrapper.id = "vm-tm-plain-composer-wrapper";
    wrapper.style.position = "fixed";
    wrapper.style.left = "0";
    wrapper.style.right = "0";
    wrapper.style.bottom = "0";
    wrapper.style.zIndex = "2147483000";
    wrapper.style.display = "flex";
    wrapper.style.justifyContent = "center";
    wrapper.style.padding = "10px";
    wrapper.style.pointerEvents = "none";

    const panel = document.createElement("div");
    panel.style.pointerEvents = "auto";
    panel.style.width = CONFIG.textareaWidth;
    panel.style.maxWidth = "calc(100vw - 20px)";
    panel.style.border = "1px solid rgba(128,128,128,0.35)";
    panel.style.borderRadius = "10px";
    panel.style.background = "rgba(20,20,20,0.85)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.padding = "10px";
    panel.style.boxShadow = "0 10px 28px rgba(0,0,0,0.35)";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "8px";

    const textarea = document.createElement("textarea");
    textarea.id = "vm-tm-plain-composer";
    textarea.placeholder = "Enter your prompt... (Ctrl/Cmd+Enter to send)";
    textarea.spellcheck = true;
    textarea.style.width = "100%";
    textarea.style.height = `${CONFIG.minHeightPx}px`;
    textarea.style.resize = "none";
    textarea.style.fontSize = CONFIG.fontSize;
    textarea.style.lineHeight = CONFIG.lineHeight;
    textarea.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    textarea.style.border = "1px solid rgba(255,255,255,0.18)";
    textarea.style.borderRadius = "8px";
    textarea.style.padding = "10px";
    textarea.style.outline = "none";
    textarea.style.color = "#fff";
    textarea.style.background = "rgba(0,0,0,0.35)";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.gap = "10px";

    const leftInfo = document.createElement("div");
    leftInfo.style.fontSize = "12px";
    leftInfo.style.opacity = "0.85";
    leftInfo.style.color = "#fff";
    leftInfo.textContent =
      "Plain composer active — Ctrl/Cmd+Enter to send — Esc to toggle the original composer";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "Toggle Original";
    styleButton(toggleBtn);

    const sendBtn = document.createElement("button");
    sendBtn.textContent = "Send";
    styleButton(sendBtn);

    btnRow.appendChild(toggleBtn);
    btnRow.appendChild(sendBtn);

    row.appendChild(leftInfo);
    row.appendChild(btnRow);

    panel.appendChild(textarea);
    panel.appendChild(row);
    wrapper.appendChild(panel);

    // append early; body may not exist yet
    document.documentElement.appendChild(wrapper);

    sendBtn.addEventListener("click", () => sendPlainMessage());
    toggleBtn.addEventListener("click", () => toggleOriginalComposer());

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const modifier = e.ctrlKey || e.metaKey;
        if (CONFIG.sendHotkeyRequiresCtrlOrCmd && modifier) {
          e.preventDefault();
          sendPlainMessage();
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        toggleOriginalComposer();
      }
    });

    textarea.addEventListener("input", () => {
      autogrow(textarea);
      saveDraftDebounced();
    });

    window.addEventListener("resize", () => autogrow(textarea));

    STATE.wrapperEl = wrapper;
    STATE.textareaEl = textarea;

    // Ensure return button exists (hidden by default)
    ensureReturnButton();

    // Draft will be loaded when DOM is ready enough (we call loadDraftIfAny() later too)
    // but we can already try now:
    loadDraftIfAny();
    autogrow(textarea);
  }

  // ---- Toggle Original ----
  function toggleOriginalComposer() {
    const real = getRealTextarea();
    if (!real) return;

    const currentlyHidden = real.style.display === "none";

    if (currentlyHidden) {
      showRealTextarea(real);
      STATE.originalVisibleByUser = true;

      if (CONFIG.hidePlainComposerWhenOriginalShown) setPlainComposerVisible(false);
      showReturnButton(true);

      real.focus();
    } else {
      if (CONFIG.hideOriginalComposer) hideRealTextarea(real);
      STATE.originalVisibleByUser = false;

      showReturnButton(false);
      setPlainComposerVisible(true);

      if (STATE.textareaEl) STATE.textareaEl.focus();
    }
  }

  // ---- Sending ----
  function setNativeValue(textarea, value) {
    const proto = Object.getPrototypeOf(textarea);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(textarea, value);
    } else {
      textarea.value = value;
    }
  }

  function dispatchKey(target, { key, code, ctrlKey, metaKey }) {
    const down = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      code,
      which: 13,
      keyCode: 13,
      ctrlKey: !!ctrlKey,
      metaKey: !!metaKey,
    });
    target.dispatchEvent(down);

    const up = new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key,
      code,
      which: 13,
      keyCode: 13,
      ctrlKey: !!ctrlKey,
      metaKey: !!metaKey,
    });
    target.dispatchEvent(up);
  }

  async function sendPlainMessage() {
    const text = STATE.textareaEl?.value ?? "";
    if (!text.trim()) return;

    const real = getRealTextarea();
    if (!real) {
      log("Real textarea not found; cannot send.");
      return;
    }

    // Show it briefly if hidden, because some apps ignore events on display:none
    const wasHidden = real.style.display === "none";
    if (wasHidden) showRealTextarea(real);

    // Set value and dispatch input events
    setNativeValue(real, text);
    real.dispatchEvent(new Event("input", { bubbles: true }));
    real.dispatchEvent(new Event("change", { bubbles: true }));

    // Let TypingMind react
    await sleep(30);

    // Try to trigger send in multiple ways
    if (CONFIG.trySendViaCtrlEnter) {
      dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: true, metaKey: false });
      await sleep(40);
    }

    if (CONFIG.trySendViaMetaEnter && real.value === text) {
      dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: true });
      await sleep(40);
    }

    if (CONFIG.trySendViaPlainEnter && real.value === text) {
      dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: false });
      await sleep(40);
    }

    if (CONFIG.trySendViaSendButton && real.value === text) {
      const btn = getSendButtonCandidate();
      if (btn) btn.click();
      await sleep(60);
    }

    // If TypingMind did not clear/change its textarea, consider send failed.
    // Restore our text so you never lose it.
    if (real.value === text) {
      log("Send attempt may have failed (TypingMind did not clear original textarea). Text restored.");
      // Restore hidden state if needed
      if (!STATE.originalVisibleByUser && CONFIG.hideOriginalComposer) hideRealTextarea(real);
      return;
    }

    // Success case (textarea changed/cleared)
    if (CONFIG.clearDraftOnSend) clearDraft();
    STATE.textareaEl.value = "";
    STATE.lastSavedValue = "";
    autogrow(STATE.textareaEl);

    if (!STATE.originalVisibleByUser && CONFIG.hideOriginalComposer) {
      hideRealTextarea(real);
    }
  }

  // ---- Install & Observe ----
  function installIfNeeded() {
    // Always create UI (this is what your previous script lacked robustness on)
    createPlainComposerUI();

    const real = getRealTextarea();
    if (!real) return;

    STATE.lastKnownRealTextarea = real;

    if (CONFIG.hideOriginalComposer && !STATE.originalVisibleByUser) {
      hideRealTextarea(real);
    }

    // Keep drafts synced per URL
    const newKey = computeDraftKey();
    if (CONFIG.persistDrafts && STATE.draftKey && newKey !== STATE.draftKey) {
      STATE.draftKey = newKey;
      loadDraftIfAny();
    } else if (CONFIG.persistDrafts && !STATE.draftKey) {
      STATE.draftKey = newKey;
      loadDraftIfAny();
    }
  }

  function handleMutations() {
    // Keep trying to bind to the real textarea (SPA re-renders)
    const real = getRealTextarea();
    if (real && STATE.lastKnownRealTextarea !== real) {
      STATE.lastKnownRealTextarea = real;

      if (CONFIG.hideOriginalComposer && !STATE.originalVisibleByUser) {
        hideRealTextarea(real);
      }
    }

    // Also check URL changes for draft key updates
    if (CONFIG.persistDrafts && STATE.textareaEl) {
      const newKey = computeDraftKey();
      if (STATE.draftKey && newKey !== STATE.draftKey) {
        STATE.draftKey = newKey;
        loadDraftIfAny();
      }
    }
  }

  function makeThrottledHandler(fn, intervalMs) {
    let scheduled = false;
    let lastRun = 0;

    return function throttled() {
      const now = Date.now();
      const elapsed = now - lastRun;

      if (elapsed >= intervalMs) {
        lastRun = now;
        scheduled = false;
        fn();
        return;
      }

      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          lastRun = Date.now();
          scheduled = false;
          fn();
        }, Math.max(0, intervalMs - elapsed));
      }
    };
  }

  function run() {
    // Create UI as early as possible
    installIfNeeded();

    // Keep trying: TypingMind may render input later
    setInterval(installIfNeeded, 1000);

    const throttledMutationHandler = makeThrottledHandler(
      () => {
        installIfNeeded();
        handleMutations();
      },
      CONFIG.mutationThrottleMs
    );

    const observer = new MutationObserver(throttledMutationHandler);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    log("Initialized TypingMind Plain Composer v1.0", {
      mutationThrottleMs: CONFIG.mutationThrottleMs,
    });
  }

  run();
})();
