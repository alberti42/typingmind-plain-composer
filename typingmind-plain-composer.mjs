// ==UserScript==
// @name         TypingMind Plain Text Composer (Hide Original)
// @namespace    vm-typingmind-plain-composer
// @version      1.8
// @description  Replace TypingMind input with a plain textarea overlay for smoother typing. Anchors to <main> + caps width to chat column. Smooth reveal (no jitter), autogrow + drafts + cleanup + stability-gated alignment + throttled MutationObserver + non-overlapping toggle UX + global hotkeys.
// @match        https://www.typingmind.com/*
// @match        https://typingmind.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    fallbackThreadMaxWidthPx: 760,

    minHeightPx: 30,
    maxHeightVh: 35,

    fontSize: "15px",
    lineHeight: "1.4",

    hideOriginalComposer: true,

    persistDrafts: true,
    clearDraftOnSend: true,
    draftSaveDebounceMs: 250,

    draftTtlDays: 30,
    maxDraftEntries: 200,

    sendHotkeyRequiresCtrlOrCmd: true,

    mutationThrottleMs: 200,

    hidePlainComposerWhenOriginalShown: true,
    showReturnButtonWhenOriginalShown: true,

    trySendViaCtrlEnter: true,
    trySendViaMetaEnter: true,
    trySendViaPlainEnter: true,
    trySendViaSendButton: true,

    // ---- Layout stability gate ----
    stableRequiredCount: 5,
    stableCheckIntervalMs: 80,
    stableTolerancePx: 2,
    postLockSyncIntervalMs: 350,

    // ---- Global hotkeys ----
    globalFocusHotkey: true,
    focusHotkeyRequiresCtrl: true, // Ctrl+` (Backquote)
    globalEscToggle: true,
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

    lastAnchorSig: "",
    hasShownOnce: false,

    // stability gating
    layoutStableCount: 0,
    layoutLastGeom: null,
    layoutLocked: false,

    // native was visible at least once
    nativeSeenOnce: false,

    // timers
    fastTimer: null,
    slowTimer: null,
  };

  // ---- helpers ----
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

  function isElementVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return !!(r.width && r.height);
  }

  function nearlyEqual(a, b, tol) {
    return Math.abs(a - b) <= tol;
  }

  function updateLayoutStability(left, width, maxW) {
    const tol = CONFIG.stableTolerancePx;
    const prev = STATE.layoutLastGeom;
    const curr = { left, width, maxW };

    if (
      prev &&
      nearlyEqual(prev.left, curr.left, tol) &&
      nearlyEqual(prev.width, curr.width, tol) &&
      nearlyEqual(prev.maxW, curr.maxW, tol)
    ) {
      STATE.layoutStableCount++;
    } else {
      STATE.layoutStableCount = 0;
    }

    STATE.layoutLastGeom = curr;
    return STATE.layoutStableCount >= CONFIG.stableRequiredCount;
  }

  // typing context guard (for global hotkeys)
  function isTypingContext(el) {
    if (!el) return false;
    if (el === document.body || el === document.documentElement) return false;

    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // treat most inputs as typing contexts
      if (!["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type)) {
        return true;
      }
    }
    if (el.isContentEditable) return true;

    // also catch nested editable contexts
    if (typeof el.closest === "function") {
      if (el.closest("textarea, input, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']")) {
        return true;
      }
    }

    return false;
  }

  // focus helper
  function focusPlainComposer({ revealIfHidden = true } = {}) {
    if (!STATE.textareaEl || !STATE.wrapperEl) return;

    if (revealIfHidden) {
      // if user had original open, flip back to plain overlay
      if (STATE.originalVisibleByUser) {
        STATE.originalVisibleByUser = false;
        showReturnButton(false);
      }
      setPlainComposerVisible(true);

      // try to hide real composer again (optional)
      const real = getRealTextarea();
      if (real && CONFIG.hideOriginalComposer && isElementVisible(real)) hideRealTextarea(real);
    }

    syncOverlayToTypingMindLayout();

    // focus + caret at end
    const ta = STATE.textareaEl;
    ta.focus({ preventScroll: true });
    const len = ta.value.length;
    try {
      ta.setSelectionRange(len, len);
    } catch {}
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

  function getChatInputContainer() {
    return (
      qs('[data-element-id="message-input"]') ||
      qs('[data-element-id="chat-space-end-part"]') ||
      qs('[data-element-id="input-row"]') ||
      qs('[data-element-id="chat-input-textbox-container"]') ||
      null
    );
  }

  function getSendButtonCandidate() {
    const candidates = []
      .concat(qsa('button[data-element-id*="send"]'))
      .concat(qsa('button[aria-label*="Send"]'))
      .concat(qsa('button[title*="Send"]'));
    return candidates.find((b) => !b.disabled) || null;
  }

  function getMainAnchor() {
    const mains = qsa("main");
    for (const m of mains) {
      const cls = m.className || "";
      const oy = getComputedStyle(m).overflowY;
      const looksScrollable =
        cls.includes("overflow-y-auto") ||
        cls.includes("overflow-y-scroll") ||
        oy === "auto" ||
        oy === "scroll";

      if (looksScrollable && isElementVisible(m)) return m;
    }

    const mca = qs('[data-element-id="main-content-area"]');
    if (isElementVisible(mca)) return mca;

    const bg = qs('[data-element-id="chat-space-background"]');
    if (isElementVisible(bg)) return bg;

    return document.documentElement;
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
        try {
          localStorage.removeItem(k);
        } catch {}
        continue;
      }

      const ts = Number(obj.ts);
      const text = typeof obj.text === "string" ? obj.text : "";

      if (!ts || ts < cutoff || text.length === 0) {
        try {
          localStorage.removeItem(k);
        } catch {}
        continue;
      }

      entries.push({ key: k, ts });
    }

    if (entries.length > CONFIG.maxDraftEntries) {
      entries.sort((a, b) => b.ts - a.ts);
      const toRemove = entries.slice(CONFIG.maxDraftEntries);
      for (const e of toRemove) {
        try {
          localStorage.removeItem(e.key);
        } catch {}
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
        localStorage.setItem(STATE.draftKey, JSON.stringify({ text: val, ts: nowMs() }));
        STATE.lastSavedValue = val;
      } catch (e) {
        log("Draft save failed:", e);
      }
    }, CONFIG.draftSaveDebounceMs);
  }

  function clearDraft() {
    if (!CONFIG.persistDrafts || !STATE.draftKey) return;
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

  // ---- Alignment scaffold ----
  function ensureAlignerScaffold() {
    if (!STATE.wrapperEl) return null;

    let aligner = STATE.wrapperEl.querySelector("#vm-tm-aligner");
    if (!aligner) {
      aligner = document.createElement("div");
      aligner.id = "vm-tm-aligner";
      aligner.style.position = "fixed";
      aligner.style.bottom = "0";
      aligner.style.zIndex = "2147483000";
      aligner.style.padding = "10px";
      aligner.style.boxSizing = "border-box";
      aligner.style.pointerEvents = "none";
      aligner.style.transition = "left 120ms ease, width 120ms ease";
      aligner.style.willChange = "left, width";

      const panel = STATE.wrapperEl.firstElementChild;
      STATE.wrapperEl.innerHTML = "";
      aligner.appendChild(panel);
      STATE.wrapperEl.appendChild(aligner);

      panel.style.pointerEvents = "auto";
      panel.style.width = "100%";
      panel.style.maxWidth = "unset";
      panel.style.margin = "0";
    }

    let threadWrap = aligner.querySelector("#vm-tm-threadwrap");
    if (!threadWrap) {
      threadWrap = document.createElement("div");
      threadWrap.id = "vm-tm-threadwrap";
      threadWrap.style.pointerEvents = "none";
      threadWrap.style.marginLeft = "auto";
      threadWrap.style.marginRight = "auto";
      threadWrap.style.maxWidth = `${CONFIG.fallbackThreadMaxWidthPx}px`;

      const panel = aligner.firstElementChild;
      aligner.innerHTML = "";
      threadWrap.appendChild(panel);
      aligner.appendChild(threadWrap);

      panel.style.pointerEvents = "auto";
      panel.style.width = "100%";
      panel.style.maxWidth = "unset";
      panel.style.margin = "0";
    }

    return { aligner, threadWrap };
  }

  function syncOverlayToTypingMindLayout() {
    if (!STATE.wrapperEl) return false;

    const anchor = getMainAnchor();
    const rect = anchor.getBoundingClientRect();

    const vw = window.innerWidth || 1;
    if (!rect.width || rect.width < 200 || rect.width > vw * 1.2) return false;

    const scaffold = ensureAlignerScaffold();
    if (!scaffold) return false;

    const { aligner, threadWrap } = scaffold;

    const left = Math.round(rect.left);
    const width = Math.round(rect.width);

    aligner.style.left = `${left}px`;
    aligner.style.width = `${width}px`;

    const inputContainer = getChatInputContainer();
    if (inputContainer) {
      const r2 = inputContainer.getBoundingClientRect();
      if (r2.width && r2.width > 320 && r2.width < vw * 1.05) {
        threadWrap.style.maxWidth = `${Math.round(r2.width)}px`;
      }
    }

    const maxW = Math.round(parseFloat(threadWrap.style.maxWidth || "0"));
    const hasReasonableWidth = maxW && maxW > 320;

    const sig = `${left}:${width}:${maxW}`;
    if (sig !== STATE.lastAnchorSig) STATE.lastAnchorSig = sig;

    // IMPORTANT: use "seen once" gating
    const nativeReady = STATE.nativeSeenOnce;

    const stable = updateLayoutStability(left, width, maxW);

    if (!STATE.hasShownOnce && nativeReady && stable && hasReasonableWidth) {
      STATE.hasShownOnce = true;
      STATE.layoutLocked = true;

      STATE.wrapperEl.style.opacity = "1";
      STATE.wrapperEl.style.transform = "translateY(0)";
    }

    return true;
  }

  // ---- Toggle UX ----
  function setPlainComposerVisible(visible) {
    if (!STATE.wrapperEl) return;
    STATE.wrapperEl.style.display = visible ? "block" : "none";
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
      if (real && CONFIG.hideOriginalComposer && isElementVisible(real)) hideRealTextarea(real);

      btn.style.display = "none";
      setPlainComposerVisible(true);

      syncOverlayToTypingMindLayout();
      if (STATE.textareaEl) STATE.textareaEl.focus();
    });

    document.documentElement.appendChild(btn);
    STATE.returnBtnEl = btn;
    return btn;
  }

  function showReturnButton(show) {
    const btn = ensureReturnButton();
    if (!btn) return;
    btn.style.display = show ? "block" : "none";
  }

  // ---- Sending ----
  function setNativeValue(textarea, value) {
    const proto = Object.getPrototypeOf(textarea);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") desc.set.call(textarea, value);
    else textarea.value = value;
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
    if (!real) return;

    const wasHidden = real.style.display === "none";
    if (wasHidden) showRealTextarea(real);

    setNativeValue(real, text);
    real.dispatchEvent(new Event("input", { bubbles: true }));
    real.dispatchEvent(new Event("change", { bubbles: true }));

    await sleep(30);

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

    if (real.value === text) {
      if (!STATE.originalVisibleByUser && CONFIG.hideOriginalComposer && isElementVisible(real)) {
        hideRealTextarea(real);
      }
      return;
    }

    if (CONFIG.clearDraftOnSend) clearDraft();

    STATE.textareaEl.value = "";
    STATE.lastSavedValue = "";
    autogrow(STATE.textareaEl);

    if (!STATE.originalVisibleByUser && CONFIG.hideOriginalComposer && isElementVisible(real)) {
      hideRealTextarea(real);
    }
  }

  // ---- UI ----
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

  function appendSafe(el) {
    if (document.body) document.body.appendChild(el);
    else document.documentElement.appendChild(el);
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
    wrapper.style.display = "block";
    wrapper.style.padding = "0";
    wrapper.style.pointerEvents = "none";

    wrapper.style.opacity = "0";
    wrapper.style.transform = "translateY(6px)";
    wrapper.style.transition = "opacity 120ms ease, transform 120ms ease";

    const panel = document.createElement("div");
    panel.style.pointerEvents = "auto";
    panel.style.width = "100%";
    panel.style.maxWidth = "unset";
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
    appendSafe(wrapper);

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

    window.addEventListener("resize", () => {
      autogrow(textarea);
      syncOverlayToTypingMindLayout();
    });

    STATE.wrapperEl = wrapper;
    STATE.textareaEl = textarea;

    ensureReturnButton();
    loadDraftIfAny();
    autogrow(textarea);

    syncOverlayToTypingMindLayout();
  }

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
      if (CONFIG.hideOriginalComposer && isElementVisible(real)) hideRealTextarea(real);
      STATE.originalVisibleByUser = false;

      showReturnButton(false);
      setPlainComposerVisible(true);

      syncOverlayToTypingMindLayout();
      if (STATE.textareaEl) STATE.textareaEl.focus();
    }
  }

  // ---- Install & Observe ----
  function installIfNeeded() {
    createPlainComposerUI();

    const real = getRealTextarea();
    if (real) {
      if (STATE.lastKnownRealTextarea !== real) {
        STATE.lastKnownRealTextarea = real;
      }

      // Set nativeSeenOnce BEFORE hiding
      if (isElementVisible(real)) {
        STATE.nativeSeenOnce = true;
      }

      if (CONFIG.hideOriginalComposer && !STATE.originalVisibleByUser) {
        if (STATE.nativeSeenOnce && isElementVisible(real)) hideRealTextarea(real);
      }
    }

    const newKey = computeDraftKey();
    if (CONFIG.persistDrafts && STATE.draftKey && newKey !== STATE.draftKey) {
      STATE.draftKey = newKey;
      loadDraftIfAny();
    } else if (CONFIG.persistDrafts && !STATE.draftKey) {
      STATE.draftKey = newKey;
      loadDraftIfAny();
    }

    syncOverlayToTypingMindLayout();
  }

  // NEW: explicit mutation handler (so throttling calls this)
  function handleMutations() {
    installIfNeeded();
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

  function installGlobalHotkeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (!STATE.textareaEl) return;

        // ESC anywhere toggles (unless you're typing in another input etc.)
        if (CONFIG.globalEscToggle && e.key === "Escape") {
          // If user is typing in some other field (e.g. search), let it handle Escape itself.
          if (document.activeElement && isTypingContext(document.activeElement) && document.activeElement !== STATE.textareaEl) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          toggleOriginalComposer();
          return;
        }

        if (!CONFIG.globalFocusHotkey) return;

        // already focused
        if (document.activeElement === STATE.textareaEl) return;

        // ignore while typing elsewhere
        if (isTypingContext(document.activeElement)) return;

        // Ctrl+` (or physical Backquote) focuses the overlay
        const wantsCtrl = CONFIG.focusHotkeyRequiresCtrl ? e.ctrlKey : true;
        const isBacktick = (e.key === "`" || e.code === "Backquote");
        const matches = wantsCtrl && isBacktick;

        if (matches) {
          // Avoid stealing common combos
          if (e.metaKey || e.altKey) return;

          e.preventDefault();
          e.stopPropagation();

          focusPlainComposer({ revealIfHidden: true });
        }
      },
      true // capture phase
    );
  }

  function run() {
    installIfNeeded();

    // Phase 1: fast checks until stable lock
    STATE.fastTimer = setInterval(() => {
      installIfNeeded();

      if (STATE.layoutLocked) {
        clearInterval(STATE.fastTimer);
        STATE.fastTimer = null;

        // Phase 2: slow checks
        if (!STATE.slowTimer) {
          STATE.slowTimer = setInterval(installIfNeeded, CONFIG.postLockSyncIntervalMs);
        }
      }
    }, CONFIG.stableCheckIntervalMs);

    const throttledMutationHandler = makeThrottledHandler(handleMutations, CONFIG.mutationThrottleMs);
    const observer = new MutationObserver(throttledMutationHandler);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    installGlobalHotkeys();

    log("Initialized TypingMind Plain Composer v1.6 (global hotkeys).", {
      mutationThrottleMs: CONFIG.mutationThrottleMs,
    });
  }

  run();
})();

// vim: set expandtab tabstop=2 shiftwidth=2 softtabstop=2 :
