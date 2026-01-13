// ==UserScript==
// @name         TypingMind Minimal Plain Composer (Fast + Send, Dark UI + Toggle + Idle Autogrow + Align)
// @namespace    vm-typingmind-plain-composer
// @version      1.7
// @description  Fast plain textarea overlay. Only touches TypingMind on Send/Toggle. Dark UI + Toggle. Ctrl/Cmd+Enter sends. Esc toggles. Autogrow is idle-debounced. Overlay is aligned/centered to chat column via idle-debounced layout sampling (no observers/polling).
// @match        https://www.typingmind.com/*
// @match        https://typingmind.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    // fallback max width for overlay
     alignPaddingPx: 0,     // set to 0 to match exactly; try 16 if you want breathing room

    // NEW: safety clamps (optional)
    minOverlayWidthPx: 360,
    maxOverlayWidthPx: 9999, // effectively "no cap"; set e.g. 1200 if you want a hard ceiling

    bottomPx: 16,
    rows: 3,

    // ---- Autogrow (idle-debounced) ----
    AUTOGROW_ENABLED: true,
    minHeightPx: 30,
    maxHeightVh: 35,
    autogrowDebounceMs: 160,

    // ---- Alignment (idle-debounced) ----
    ALIGN_ENABLED: true,
    alignDebounceMs: 180,

    // If true, keep a scrollbar instead of resizing (max perf)
    preferScrollbarsOverAutogrow: false,
  };

  const STATE = {
    mode: "plain", // "plain" | "native"
    wrap: null,
    ta: null,
    hasShownOnce: false,

    // autogrow
    autogrowTimer: null,
    lastGrowValueLen: -1,

    // alignment
    alignTimer: null,
    lastAlignSig: "",
  };

  // ---------- Helpers ----------
  function qs(sel, root = document) {
    return root.querySelector(sel);
  }
  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- TypingMind selectors (ONLY used on Send/Toggle/Align) ----------
  function getRealTextarea() {
    return (
      qs("textarea#chat-input-textbox") ||
      qs('textarea[data-element-id="chat-input-textbox"]') ||
      qs("textarea.main-chat-input") ||
      null
    );
  }

  function getChatInputContainer() {
    // These are containers you already had good luck with
    return (
      qs('[data-element-id="message-input"]') ||
      qs('[data-element-id="chat-space-end-part"]') ||
      qs('[data-element-id="input-row"]') ||
      qs('[data-element-id="chat-input-textbox-container"]') ||
      null
    );
  }

  function getMainAnchor() {
    // Try to find the visible main chat area
    const mains = qsa("main");
    for (const m of mains) {
      const cs = getComputedStyle(m);
      const oy = cs.overflowY;
      const looksScrollable = oy === "auto" || oy === "scroll";
      if (looksScrollable && isVisible(m)) return m;
    }

    // common TM containers (best-effort)
    const mca = qs('[data-element-id="main-content-area"]');
    if (isVisible(mca)) return mca;

    const bg = qs('[data-element-id="chat-space-background"]');
    if (isVisible(bg)) return bg;

    return document.documentElement;
  }

  function getSendButtonCandidate() {
    const candidates = []
      .concat(qsa('button[data-element-id*="send"]'))
      .concat(qsa('button[aria-label*="Send"]'))
      .concat(qsa('button[title*="Send"]'))
      .concat(qsa('button[type="submit"]'));
    return candidates.find((b) => b && !b.disabled) || null;
  }

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

  // ---------- Hide/show native (keep measurable!) ----------
  // NOTE: We do NOT use display:none in plain mode, because that kills the rect width/left.
  // Instead we make it visually/interaction hidden but still measurable.
  function hideNativeComposer() {
    const container = getChatInputContainer() || (getRealTextarea() ? getRealTextarea().closest("form") : null);
    if (!container) return false;

    if (!container.dataset.vmPlainHidden) {
      container.dataset.vmPlainHidden = "1";
      container.style.opacity = "0";
      container.style.pointerEvents = "none";
      container.style.userSelect = "none";
      // keep layout/width measurable
    }
    return true;
  }

  function showNativeComposer() {
    const container = getChatInputContainer() || (getRealTextarea() ? getRealTextarea().closest("form") : null);
    if (!container) return false;

    if (container.dataset.vmPlainHidden) {
      delete container.dataset.vmPlainHidden;
      container.style.opacity = "";
      container.style.pointerEvents = "";
      container.style.userSelect = "";
    }
    return true;
  }

  function setPlainVisible(visible) {
    if (!STATE.wrap) return;
    STATE.wrap.style.display = visible ? "block" : "none";
  }

  function setMode(mode) {
    STATE.mode = mode;

    if (mode === "native") {
      showNativeComposer();
      setPlainVisible(false);

      const real = getRealTextarea();
      if (real) real.focus();

      // alignment not needed while hidden, but harmless
      scheduleAlign();
    } else {
      setPlainVisible(true);
      hideNativeComposer();

      if (STATE.ta) {
        STATE.ta.focus({ preventScroll: true });
        scheduleAutogrow();
      }

      scheduleAlign();
    }
  }

  // ---------- Autogrow (idle-debounced) ----------
  function doAutogrow() {
    const ta = STATE.ta;
    if (!ta || !CONFIG.AUTOGROW_ENABLED) return;

    if (CONFIG.preferScrollbarsOverAutogrow) {
      ta.style.height = "";
      ta.style.maxHeight = `${Math.round((window.innerHeight * CONFIG.maxHeightVh) / 100)}px`;
      ta.style.overflowY = "auto";
      return;
    }

    const len = ta.value.length;
    if (len === STATE.lastGrowValueLen) return;
    STATE.lastGrowValueLen = len;

    ta.style.height = "auto";
    const maxPx = Math.round((window.innerHeight * CONFIG.maxHeightVh) / 100);
    const newPx = Math.min(Math.max(ta.scrollHeight, CONFIG.minHeightPx), maxPx);
    ta.style.height = `${newPx}px`;
  }

  function scheduleAutogrow() {
    if (!CONFIG.AUTOGROW_ENABLED) return;
    if (STATE.mode !== "plain") return;

    if (STATE.autogrowTimer) clearTimeout(STATE.autogrowTimer);
    STATE.autogrowTimer = setTimeout(() => {
      STATE.autogrowTimer = null;
      doAutogrow();
    }, CONFIG.autogrowDebounceMs);
  }

  // ---------- Alignment (idle-debounced) ----------
  function computeAnchorRect() {
    // Prefer the actual input row/container when present (best centering match)
    const input = getChatInputContainer();
    if (input && input.getBoundingClientRect) {
      const r = input.getBoundingClientRect();
      if (r.width > 200) return r;
    }

    // Fallback: main chat area
    const main = getMainAnchor();
    if (main && main.getBoundingClientRect) {
      const r = main.getBoundingClientRect();
      if (r.width > 200) return r;
    }

    return null;
  }

  function doAlign() {
    if (!CONFIG.ALIGN_ENABLED) return;
    if (!STATE.wrap) return;
    if (STATE.mode !== "plain") return;

    const r = computeAnchorRect();
    if (!r) return;

    const vw = window.innerWidth || 1;

    const padding = Math.max(0, CONFIG.alignPaddingPx || 0);
    const desired = Math.round(r.width - padding);

    const maxByViewport = Math.round(vw - 24);
    const maxByConfig = Math.round(CONFIG.maxOverlayWidthPx || 9999);

    const width = Math.max(
      Math.round(CONFIG.minOverlayWidthPx || 320),
      Math.min(desired, maxByViewport, maxByConfig)
    );

    const cx = Math.round(r.left + r.width / 2);

    const sig = `${cx}:${width}:${Math.round(r.left)}:${Math.round(r.width)}:${vw}`;
    if (sig === STATE.lastAlignSig) return;
    STATE.lastAlignSig = sig;

    STATE.wrap.style.left = `${cx}px`;
    STATE.wrap.style.width = `${width}px`;

    // reveal once we have a real measured size
    if (!STATE.hasShownOnce) {
      STATE.hasShownOnce = true;
      STATE.wrap.style.opacity = "1";
    }
    STATE.wrap.style.transform = "translateX(-50%) translateY(0)";

    if (!STATE.hasShownOnce) {
      STATE.hasShownOnce = true;
      revealOverlay();
    }
  }



  function scheduleAlign() {
    if (!CONFIG.ALIGN_ENABLED) return;
    if (STATE.alignTimer) clearTimeout(STATE.alignTimer);
    STATE.alignTimer = setTimeout(() => {
      STATE.alignTimer = null;
      doAlign();
    }, CONFIG.alignDebounceMs);
  }

  // ---------- Send (commit phase) ----------
  async function sendFromOverlay() {
    const ta = STATE.ta;
    const textTrimmed = (ta?.value ?? "").trim();
    if (!textTrimmed) return;

    const real = getRealTextarea();
    if (!real) {
      console.warn("[TMPlain] Native textarea not found yet; cannot send.");
      return;
    }

    const wasPlain = STATE.mode === "plain";
    if (wasPlain) showNativeComposer(); // temporarily allow TM to handle send normally

    setNativeValue(real, ta.value);
    real.dispatchEvent(new Event("input", { bubbles: true }));
    real.dispatchEvent(new Event("change", { bubbles: true }));

    await sleep(25);

    dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: true, metaKey: false });
    await sleep(35);

    if (real.value === ta.value) {
      dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: true });
      await sleep(35);
    }

    if (real.value === ta.value) {
      dispatchKey(real, { key: "Enter", code: "Enter", ctrlKey: false, metaKey: false });
      await sleep(35);
    }

    if (real.value === ta.value) {
      const btn = getSendButtonCandidate();
      if (btn) btn.click();
      await sleep(60);
    }

    if (real.value !== ta.value) {
      ta.value = "";
      STATE.lastGrowValueLen = -1;
      scheduleAutogrow();
      scheduleAlign();
      ta.focus({ preventScroll: true });

      if (wasPlain) hideNativeComposer();
    } else {
      console.warn("[TMPlain] Send may not have triggered; overlay text kept.");
      if (wasPlain) hideNativeComposer();
    }
  }

  // ---------- UI ----------

  function hideOverlayUntilReady() {
    if (!STATE.wrap) return;
    STATE.wrap.style.opacity = "0";
    STATE.wrap.style.pointerEvents = "none";
  }

  function revealOverlay() {
    if (!STATE.wrap) return;
    STATE.wrap.style.opacity = "1";
    STATE.wrap.style.pointerEvents = "auto";
  }

  function inject() {
    if (document.getElementById("vm-tm-plain-wrap")) return;

    const wrap = document.createElement("div");
    STATE.hasShownOnce = false;

    wrap.style.opacity = "0";
    wrap.style.pointerEvents = "none";
    wrap.style.transition = "opacity 120ms ease";

    wrap.id = "vm-tm-plain-wrap";
    wrap.style.position = "fixed";
    wrap.style.left = "50%"; // will be overwritten by align
    wrap.style.bottom = `${CONFIG.bottomPx}px`;
    wrap.style.zIndex = "2147483647";
    wrap.style.width = "min(900px, calc(100vw - 24px))";
    wrap.style.pointerEvents = "auto";
    wrap.style.display = "block";

    wrap.style.opacity = "0";
    wrap.style.transform = "translateX(-50%) translateY(6px)";
    wrap.style.transition = "opacity 120ms ease, transform 120ms ease";

    const panel = document.createElement("div");
    panel.style.border = "1px solid rgba(128,128,128,0.35)";
    panel.style.borderRadius = "12px";
    panel.style.background = "rgba(20,20,20,0.85)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.padding = "10px";
    panel.style.boxShadow = "0 10px 28px rgba(0,0,0,0.35)";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "8px";

    const ta = document.createElement("textarea");
    ta.id = "vm-tm-plain-textarea";
    ta.placeholder = "Plain composer (fast). Ctrl/Cmd+Enter to send. Esc toggles.";
    ta.spellcheck = true;
    ta.rows = CONFIG.rows;

    ta.style.width = "100%";
    ta.style.boxSizing = "border-box";
    ta.style.padding = "10px 12px";
    ta.style.borderRadius = "10px";
    ta.style.border = "1px solid rgba(255,255,255,0.18)";
    ta.style.fontSize = "15px";
    ta.style.lineHeight = "1.4";
    ta.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    ta.style.background = "rgba(0,0,0,0.35)";
    ta.style.color = "#fff";
    ta.style.outline = "none";

    if (CONFIG.AUTOGROW_ENABLED && !CONFIG.preferScrollbarsOverAutogrow) {
      ta.style.resize = "none";
      ta.style.overflow = "hidden";
    } else {
      ta.style.resize = "vertical";
      ta.style.overflowY = "auto";
    }

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "10px";

    const info = document.createElement("div");
    info.textContent = "Plain mode — debounced autogrow + debounced align. Send/Toggle only.";
    info.style.fontSize = "12px";
    info.style.opacity = "0.85";
    info.style.color = "#fff";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    function styleBtn(b) {
      b.style.border = "1px solid rgba(255,255,255,0.2)";
      b.style.borderRadius = "10px";
      b.style.padding = "8px 12px";
      b.style.cursor = "pointer";
      b.style.background = "rgba(255,255,255,0.10)";
      b.style.color = "#fff";
      b.style.fontSize = "13px";
      b.style.userSelect = "none";
    }

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "Toggle Original";
    styleBtn(toggleBtn);

    const sendBtn = document.createElement("button");
    sendBtn.textContent = "Send";
    styleBtn(sendBtn);

    btnRow.appendChild(toggleBtn);
    btnRow.appendChild(sendBtn);

    row.appendChild(info);
    row.appendChild(btnRow);

    panel.appendChild(ta);
    panel.appendChild(row);
    wrap.appendChild(panel);

    (document.body || document.documentElement).appendChild(wrap);

    // Keep TypingMind from reacting to keystrokes while you type here
    ta.addEventListener(
      "keydown",
      (e) => {
        e.stopPropagation();

        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          sendFromOverlay();
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          setMode(STATE.mode === "plain" ? "native" : "plain");
          return;
        }
      },
      true
    );

    ta.addEventListener(
      "input",
      (e) => {
        e.stopPropagation();
        scheduleAutogrow();
        // do NOT align on every key; alignment is about layout changes, not text
      },
      true
    );

    sendBtn.addEventListener("click", () => sendFromOverlay());
    toggleBtn.addEventListener("click", () => setMode(STATE.mode === "plain" ? "native" : "plain"));

    window.addEventListener("resize", () => {
      STATE.lastGrowValueLen = -1;
      scheduleAutogrow();
      scheduleAlign();
    });

    STATE.wrap = wrap;
    STATE.ta = ta;

    // Start in plain mode
    setMode("plain");

    // Initial autogrow + alignment (debounced)
    scheduleAutogrow();
    scheduleAlign();

    // A few one-shot alignment retries (covers sidebar animation / late layout)
    tryAlignSoon();
    tryHideNativeSoon();
  }

  function tryHideNativeSoon() {
    const tries = [0, 200, 800, 2000];
    tries.forEach((t) => {
      setTimeout(() => {
        if (STATE.mode === "plain") hideNativeComposer();
      }, t);
    });
  }

  function tryAlignSoon() {
    const tries = [0, 120, 300, 800, 1500, 2500];
    tries.forEach((t) => setTimeout(() => scheduleAlign(), t));
  }

  // Optional: global Esc returns to plain if you're in native mode
  function installGlobalEsc() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        if (document.activeElement === STATE.ta) return;
        if (STATE.mode === "native") setMode("plain");
      },
      true
    );
  }

  inject();
  document.addEventListener("DOMContentLoaded", () => {
    inject();
    tryAlignSoon();
    tryHideNativeSoon();
  });
  window.addEventListener("load", () => {
    inject();
    tryAlignSoon();
    tryHideNativeSoon();
  });

  installGlobalEsc();
})();
