// ==UserScript==
// @name         Extract Document HTML without sign in
// @namespace    https://violentmonkey.github.io/
// @version      5.7
// @description  Extract Rocket Lawyer document HTML without signing in; cache interview labels, auto-advance sections, close registration and Copilot popups, and download or convert HTML.
// @author       LLM:Grok, ChatGPT
// @match        *://*.rocketlawyer.com/interviews/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ------------------------------------------------------------
  // SETTINGS
  // ------------------------------------------------------------

  var LABEL_CACHE_KEY = "rl-interview-label-cache-v1";

  var MAX_STEPS = 100;
  var STEP_TIMEOUT = 15000;
  var INITIAL_BUTTON_TIMEOUT = 10000;
  var DOCUMENT_WAIT_TIMEOUT = 20000;
  var COPILOT_WAIT_TIMEOUT = 7000;

  var labelCache = {};
  var labelScanTimer = null;
  var observedRoots = new WeakSet();

  var autoAdvanceRunning = false;
  var autoStopRequested = false;
  var autoButton = null;

  // ------------------------------------------------------------
  // LABEL CACHE
  // ------------------------------------------------------------

  function loadLabelCache() {
    try {
      var saved = sessionStorage.getItem(LABEL_CACHE_KEY);

      if (saved) {
        var parsed = JSON.parse(saved);

        if (parsed && typeof parsed === "object") {
          labelCache = parsed;
        }
      }
    } catch (err) {
      console.warn("[RL Extract] Could not load label cache:", err);
    }
  }

  function saveLabelCache() {
    try {
      sessionStorage.setItem(
        LABEL_CACHE_KEY,
        JSON.stringify(labelCache)
      );
    } catch (err) {
      console.warn("[RL Extract] Could not save label cache:", err);
    }
  }

  // ------------------------------------------------------------
  // SEARCH NORMAL DOM AND OPEN SHADOW DOM
  // ------------------------------------------------------------

  function walkShadows(root, selector, results) {
    if (!results) results = [];
    if (!root || !root.querySelectorAll) return results;

    root.querySelectorAll(selector).forEach(function (el) {
      results.push(el);
    });

    root.querySelectorAll("*").forEach(function (el) {
      if (el.shadowRoot) {
        walkShadows(el.shadowRoot, selector, results);
      }
    });

    return results;
  }

  function clean(s) {
    return String(s || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sanitizeFilename(str) {
    return clean(str)
      .replace(/[\/\\?%*:|"<>]/g, "-")
      .substring(0, 80) || "Rocket Lawyer Document";
  }

  function fieldText(field) {
    var direct = clean(field.innerText || field.textContent || "");

    if (direct) return direct;

    if (field.shadowRoot) {
      return clean(field.shadowRoot.textContent || "");
    }

    return "";
  }

  // ------------------------------------------------------------
  // VISIBILITY CHECK
  // ------------------------------------------------------------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    var style = window.getComputedStyle(el);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      el.hasAttribute("hidden")
    ) {
      return false;
    }

    var rect = el.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ------------------------------------------------------------
  // BUILD AND CACHE INTERVIEW LABELS
  // ------------------------------------------------------------

  function buildLabelMap() {
    var currentMap = {};

    var inputs = walkShadows(
      document,
      "input[id^='rl-'], textarea[id^='rl-'], select[id^='rl-']"
    );

    // Get labels from surrounding .field containers.
    inputs.forEach(function (inp) {
      var id = inp.id || "";
      var fieldId = id.replace(/^rl-/, "");

      if (!fieldId) return;

      var field = inp.closest(".field");

      if (field) {
        var text = clean(
          field.innerText || field.textContent || ""
        );

        if (text && text.length < 120) {
          currentMap[fieldId] = text;
        }
      }
    });

    // Actual labels.
    var labels = walkShadows(document, "label[for]");

    labels.forEach(function (lab) {
      var forId = lab.getAttribute("for") || "";

      if (forId.indexOf("rl-") !== 0) return;

      var fieldId = forId.slice(3);

      if (!fieldId || currentMap[fieldId]) return;

      var text = clean(lab.textContent);

      if (text && text.length < 120) {
        currentMap[fieldId] = text;
      }
    });

    // aria-label / placeholder fallback.
    inputs.forEach(function (inp) {
      var id = inp.id || "";
      var fieldId = id.replace(/^rl-/, "");

      if (!fieldId || currentMap[fieldId]) return;

      var aria = clean(
        inp.getAttribute("aria-label") ||
        inp.getAttribute("placeholder") ||
        ""
      );

      if (aria && aria.length < 120) {
        currentMap[fieldId] = aria;
      }
    });

    // Save newly discovered labels.
    var changed = false;

    Object.keys(currentMap).forEach(function (id) {
      if (labelCache[id] !== currentMap[id]) {
        labelCache[id] = currentMap[id];
        changed = true;
      }
    });

    if (changed) saveLabelCache();

    return Object.assign({}, labelCache, currentMap);
  }

  // ------------------------------------------------------------
  // MONITOR INTERVIEW CHANGES
  // ------------------------------------------------------------

  function watchLabelRoots(root) {
    if (!root || !root.querySelectorAll) return;

    if (!observedRoots.has(root)) {
      observedRoots.add(root);

      labelMutationObserver.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "id",
          "for",
          "class",
          "aria-label",
          "placeholder"
        ]
      });
    }

    root.querySelectorAll("*").forEach(function (el) {
      if (el.shadowRoot) {
        watchLabelRoots(el.shadowRoot);
      }
    });
  }

  var labelMutationObserver = new MutationObserver(function () {
    if (labelScanTimer !== null) return;

    labelScanTimer = setTimeout(function () {
      labelScanTimer = null;

      buildLabelMap();
      watchLabelRoots(document.documentElement);

    }, 250);
  });

  function startLabelTracking() {
    loadLabelCache();

    buildLabelMap();
    watchLabelRoots(document.documentElement);

    console.log(
      "[RL Extract] Label tracking started:",
      Object.keys(labelCache).length,
      "cached labels"
    );
  }

  // ------------------------------------------------------------
  // AUTOMATICALLY MINIMIZE ROCKET LAWYER COPILOT
  // ------------------------------------------------------------

  async function closeCopilotChat(timeoutMs) {
    timeoutMs = timeoutMs || COPILOT_WAIT_TIMEOUT;

    var deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {

      if (autoStopRequested) {
        console.log("[RL Extract] Copilot closing cancelled.");
        return false;
      }

      var buttons = walkShadows(
        document,
        '.copilot-content button[aria-label="Minimize copilot chat"]'
      );

      var closeButton = buttons.find(isVisible);

      if (closeButton) {
        console.log("[RL Extract] Closing Rocket Lawyer Copilot.");

        closeButton.click();

        await sleep(500);

        console.log("[RL Extract] Copilot minimized.");

        return true;
      }

      await sleep(250);
    }

    console.log("[RL Extract] No visible Copilot chat found.");

    return false;
  }

  // ------------------------------------------------------------
  // FIND CONTINUE BUTTON
  // ------------------------------------------------------------

  function findContinueButton() {
    var buttons = walkShadows(document, "#continue-button");

    return buttons.find(function (el) {
      return el.tagName === "BUTTON" && isVisible(el);
    }) || null;
  }

  // ------------------------------------------------------------
  // FIND SIGN-UP DIALOG
  // ------------------------------------------------------------

  function findSignupDialog() {
    var dialogs = walkShadows(
      document,
      '[data-testid="unified-registration-dialog-sign-up"], ' +
      '#unified-registration-dialog-sign-up'
    );

    return dialogs.find(function (el) {
      return (
        isVisible(el) &&
        el.getAttribute("data-state") !== "closed"
      );
    }) || null;
  }

  // ------------------------------------------------------------
  // CURRENT INTERVIEW SECTION SIGNATURE
  // ------------------------------------------------------------

  function currentStepSignature() {
    var inputs = walkShadows(
      document,
      "input[id^='rl-'], textarea[id^='rl-'], select[id^='rl-']"
    ).filter(isVisible);

    var parts = inputs.map(function (input) {
      var field = input.closest(".field");

      var text = field
        ? clean(field.innerText || field.textContent || "")
        : "";

      return [
        input.id,
        input.value || "",
        text
      ].join(":");
    });

    if (parts.length) return parts.join("|");

    var fields = walkShadows(
      document,
      ".field"
    ).filter(isVisible);

    return fields.map(function (field) {
      return clean(field.innerText || field.textContent || "");
    }).join("|");
  }

  // ------------------------------------------------------------
  // WAIT FOR NEXT SECTION OR SIGN-UP DIALOG
  // ------------------------------------------------------------

  async function waitForNextStep(oldSignature, oldButton) {
    var deadline = Date.now() + STEP_TIMEOUT;

    while (Date.now() < deadline) {
      if (autoStopRequested) return "stopped";

      if (findSignupDialog()) {
        console.log("[RL Extract] Sign-up dialog detected.");
        return "signup";
      }

      var newSignature = currentStepSignature();

      if (
        newSignature &&
        oldSignature &&
        newSignature !== oldSignature
      ) {
        return "advanced";
      }

      var newButton = findContinueButton();

      if (
        oldButton &&
        !oldButton.isConnected &&
        newButton
      ) {
        return "advanced";
      }

      await sleep(250);
    }

    return "timeout";
  }

  async function waitForContinueButton() {
    var deadline = Date.now() + INITIAL_BUTTON_TIMEOUT;

    while (Date.now() < deadline) {
      if (autoStopRequested) return "stopped";

      if (findSignupDialog()) return "signup";

      if (findContinueButton()) return "continue";

      await sleep(250);
    }

    return "timeout";
  }

  // ------------------------------------------------------------
  // FIND DOCUMENT PREVIEW SECTIONS
  // ------------------------------------------------------------

  function findSections() {
    var host = document.querySelector("rocket-document");
    var roots = [];

    if (host) {
      if (host.shadowRoot) roots.push(host.shadowRoot);
      roots.push(host);
    }

    roots.push(document);

    var seen = [];
    var found = [];

    roots.forEach(function (root) {
      walkShadows(root, ".htmlGenerated", []).forEach(function (el) {
        if (seen.indexOf(el) === -1) {
          seen.push(el);
          found.push(el);
        }
      });
    });

    return found;
  }

  // ------------------------------------------------------------
  // NOTIFICATIONS
  // ------------------------------------------------------------

  function toast(message, ok) {
    var old = document.getElementById("rl-extract-toast");

    if (old) old.remove();

    var el = document.createElement("div");
    el.id = "rl-extract-toast";

    el.textContent = ok
      ? message
      : message + "  (Click here to close)";

    el.style.cssText =
      "position:fixed;bottom:120px;right:24px;z-index:100001;" +
      "max-width:360px;padding:12px 16px;border-radius:8px;color:#fff;" +
      "font:13px/1.5 system-ui,sans-serif;" +
      "box-shadow:0 6px 18px rgba(0,0,0,.2);" +
      "background:" + (ok ? "#198754" : "#b02a37");

    if (!ok) {
      el.style.cursor = "pointer";
      el.title = "Click to dismiss";
      el.setAttribute("role", "button");
      el.tabIndex = 0;

      el.addEventListener("click", function () {
        el.remove();
      });

      el.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          el.remove();
        }
      });

    } else {
      setTimeout(function () {
        if (el.parentNode) el.remove();
      }, 6000);
    }

    document.body.appendChild(el);
  }

  // ------------------------------------------------------------
  // EXTRACT DOCUMENT CONTENT
  // ------------------------------------------------------------

  function extractContent() {
    var sections = findSections();

    if (!sections.length) {
      throw new Error(
        "No .htmlGenerated block found. The document preview may not be available yet."
      );
    }

    var labelMap = buildLabelMap();

    console.log("[RL Extract] Cached interview labels:", labelMap);

    var docTitle = "";
    var primaryName = "";
    var primaryDate = "";
    var parts = [];
    var missing = 0;
    var labeled = 0;

    sections.forEach(function (section) {
      var liveFields = Array.prototype.slice.call(
        section.querySelectorAll("rl-field")
      );

      var clone = section.cloneNode(true);

      var cloneFields = Array.prototype.slice.call(
        clone.querySelectorAll("rl-field")
      );

      if (!docTitle) {
        var h1 = clone.querySelector("h1");

        if (h1) docTitle = clean(h1.textContent);
      }

      liveFields.forEach(function (live, i) {
        var target = cloneFields[i];

        if (!target) return;

        var id = live.getAttribute("field-id") || "";
        var text = fieldText(live);

        var isEmpty =
          live.classList.contains("empty") || !text;

        if (isEmpty) {
          var label = labelMap[id];

          if (label) {
            labeled++;

            target.replaceWith(
              document.createTextNode("[" + label + "]")
            );

          } else {
            missing++;

            target.replaceWith(
              document.createTextNode("[unfilled out field]")
            );
          }

        } else {
          target.replaceWith(
            document.createTextNode(text)
          );

          if (!primaryName && live.closest("h1") && text.length < 80) {
            primaryName = text;
          }

          if (!primaryDate && /\d{4}/.test(text) && text.length < 40) {
            primaryDate = text;
          }
        }
      });

      parts.push(clone.innerHTML);
    });

    var bodyHtml = parts.join("\n\n")
      .replace(/&nbsp;/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    bodyHtml = bodyHtml.replace(
      /<h1([^>]*)>/gi,
      '<h1 style="text-align:center;font-size:28pt;margin-bottom:0.3em;">'
    );

    var baseName = docTitle || "Rocket Lawyer Document";

    if (
      primaryName &&
      baseName.toLowerCase().indexOf(primaryName.toLowerCase()) === -1
    ) {
      baseName += " - " + primaryName;
    }

    if (primaryDate && baseName.indexOf(primaryDate) === -1) {
      baseName += " - " + primaryDate;
    }

    baseName = sanitizeFilename(baseName);

    var fullHtml =
      "<!DOCTYPE html>\n" +
      '<html lang="en">\n' +
      "<head>\n" +
      '<meta charset="UTF-8">\n' +
      "<title>" + baseName + "</title>\n" +
      "<style>" +
      "body{font-family:Georgia,'Times New Roman',serif;" +
      "max-width:820px;margin:2rem auto;line-height:1.55;" +
      "color:#222;padding:0 1.5rem}" +
      "h1{text-align:center}" +
      "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      bodyHtml +
      "\n</body>\n</html>";

    toast(
      "Labeled: " + labeled +
      " · Generic: " + missing +
      " · Cached labels: " + Object.keys(labelMap).length,
      true
    );

    return {
      fullHtml: fullHtml,
      pandocHtml: bodyHtml,
      filenameHtml: baseName + ".html",
      filenameDocx: baseName + ".docx",
      filenameOdt: baseName + ".odt",
      filenamePdf: baseName + ".pdf"
    };
  }

  // ------------------------------------------------------------
  // DOWNLOAD HTML
  // ------------------------------------------------------------

  function downloadBlob(filename, html) {
    var blob = new Blob(
      [html],
      { type: "text/html;charset=utf-8" }
    );

    var url = URL.createObjectURL(blob);

    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";

    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
  }

  // ------------------------------------------------------------
  // CLOSE SIGN-UP DIALOG, MINIMIZE COPILOT, THEN DOWNLOAD
  // ------------------------------------------------------------

  async function finishAutoDownload(steps) {
    toast(
      "Sign-up dialog detected after " + steps +
      " sections. Closing dialog...",
      true
    );

    // STEP 1: Close the registration dialog.

    var dialog = findSignupDialog();

    if (dialog) {
      var closeButton = Array.from(
        dialog.querySelectorAll("button")
      ).find(function (btn) {
        var label = btn.querySelector(".sr-only");

        return label &&
          clean(label.textContent).toLowerCase() === "close";
      });

      // Fallback: first direct button child is the X button.
      if (!closeButton) {
        closeButton = Array.from(dialog.children).find(
          function (el) {
            return el.tagName === "BUTTON";
          }
        );
      }

      if (!closeButton) {
        throw new Error(
          "Found the registration dialog, but could not find its Close button."
        );
      }

      console.log(
        "[RL Extract] Clicking registration dialog Close button."
      );

      closeButton.click();

      // Wait until the dialog actually disappears.
      var closeDeadline = Date.now() + 8000;
      var closed = false;

      while (Date.now() < closeDeadline) {
        if (autoStopRequested) {
          toast("Stopped while closing the registration dialog.", false);
          return;
        }

        var stillOpen =
          dialog.isConnected &&
          dialog.getAttribute("data-state") !== "closed" &&
          isVisible(dialog) &&
          findSignupDialog() !== null;

        if (!stillOpen) {
          closed = true;
          break;
        }

        await sleep(150);
      }

      if (!closed) {
        throw new Error(
          "Clicked Close, but the registration dialog did not disappear."
        );
      }

      console.log(
        "[RL Extract] Registration dialog successfully closed."
      );

      await sleep(500);
    }

    // STEP 2: Minimize the Rocket Lawyer Copilot popup.

    toast("Checking for the Rocket Lawyer Copilot popup...", true);

    await closeCopilotChat(COPILOT_WAIT_TIMEOUT);

    if (autoStopRequested) {
      toast("Auto-advance stopped before download.", false);
      return;
    }

    await sleep(500);

    // STEP 3: Wait for document preview and download.

    toast(
      "Popups closed. Preparing document download...",
      true
    );

    var deadline = Date.now() + DOCUMENT_WAIT_TIMEOUT;

    while (Date.now() < deadline) {
      if (autoStopRequested) {
        toast("Auto-advance stopped before download.", false);
        return;
      }

      if (findSignupDialog()) {
        throw new Error(
          "The registration dialog reopened. Download cancelled."
        );
      }

      buildLabelMap();

      var sections = findSections();

      if (sections.length) {
        console.log(
          "[RL Extract] Document preview available:",
          sections.length,
          "section(s)"
        );

        var result = extractContent();

        downloadBlob(
          result.filenameHtml,
          result.fullHtml
        );

        toast(
          "Download initiated: " +
          result.filenameHtml +
          " after " + steps + " sections.",
          true
        );

        console.log(
          "[RL Extract] Download initiated:",
          result.filenameHtml
        );

        return;
      }

      await sleep(300);
    }

    throw new Error(
      "The popups closed, but the document preview did not become available within " +
      (DOCUMENT_WAIT_TIMEOUT / 1000) +
      " seconds."
    );
  }

  // ------------------------------------------------------------
  // AUTO-ADVANCE INTERVIEW
  // ------------------------------------------------------------

  async function autoAdvanceAndDownload() {
    if (autoAdvanceRunning) return;

    autoAdvanceRunning = true;
    autoStopRequested = false;

    if (autoButton) {
      autoButton.textContent = "Stop Auto-Advance";
      autoButton.style.background = "#dc3545";
    }

    var steps = 0;

    toast("Auto-advance started.", true);

    try {
      buildLabelMap();
      watchLabelRoots(document.documentElement);

      while (steps < MAX_STEPS) {
        if (autoStopRequested) {
          toast(
            "Auto-advance stopped. Labels collected: " +
            Object.keys(labelCache).length,
            false
          );
          return;
        }

        if (findSignupDialog()) {
          await finishAutoDownload(steps);
          return;
        }

        var button = findContinueButton();

        if (!button) {
          var waitResult = await waitForContinueButton();

          if (waitResult === "signup") {
            await finishAutoDownload(steps);
            return;
          }

          if (waitResult === "stopped") {
            toast("Auto-advance stopped.", false);
            return;
          }

          if (waitResult === "timeout") {
            throw new Error(
              "Could not find a visible Continue button or sign-up dialog."
            );
          }

          button = findContinueButton();
        }

        if (!button) {
          throw new Error("Continue button disappeared.");
        }

        if (
          button.disabled ||
          button.getAttribute("aria-disabled") === "true"
        ) {
          throw new Error(
            "Continue is disabled. Check this section for an unanswered required question."
          );
        }

        buildLabelMap();

        var oldSignature = currentStepSignature();

        console.log(
          "[RL Extract] Advancing from section:",
          steps + 1,
          "Labels cached:",
          Object.keys(labelCache).length
        );

        button.click();
        steps++;

        var outcome = await waitForNextStep(
          oldSignature,
          button
        );

        if (outcome === "signup") {
          await finishAutoDownload(steps);
          return;
        }

        if (outcome === "stopped") {
          toast(
            "Auto-advance stopped after " + steps + " sections.",
            false
          );
          return;
        }

        if (outcome === "timeout") {
          throw new Error(
            "The interview did not advance after clicking Continue. " +
            "It may require an answer or another action."
          );
        }

        await sleep(350);

        buildLabelMap();
        watchLabelRoots(document.documentElement);
      }

      throw new Error(
        "Reached the safety limit of " + MAX_STEPS + " sections."
      );

    } catch (err) {
      console.error("[RL Extract] Auto-advance error:", err);

      toast(
        "Auto-advance stopped after " + steps +
        " sections: " +
        (err && err.message ? err.message : String(err)),
        false
      );

    } finally {
      autoAdvanceRunning = false;
      autoStopRequested = false;

      if (autoButton) {
        autoButton.textContent = "Auto-advance & Download HTML";
        autoButton.style.background = "#6f42c1";
      }
    }
  }

  // ------------------------------------------------------------
  // AUTO-ADVANCE BUTTON ACTION
  // ------------------------------------------------------------

  function onAutoAdvance(event) {
    event.preventDefault();
    event.stopPropagation();

    if (autoAdvanceRunning) {
      autoStopRequested = true;
      toast("Stopping after the current page change...", false);
      return;
    }

    autoAdvanceAndDownload();
  }

  // ------------------------------------------------------------
  // PANDOC INSTRUCTION BANNER
  // ------------------------------------------------------------

  function showInstructionBanner(result) {
    var existing = document.getElementById("rl-pandoc-instruction");

    if (existing) existing.remove();

    var banner = document.createElement("div");

    banner.id = "rl-pandoc-instruction";

    banner.innerHTML =
      '<div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start">' +

      '<div>' +

      '<div style="font-size:18px;font-weight:700;margin-bottom:10px">' +
      "HTML copied — finish conversion in Pandoc" +
      "</div>" +

      '<div style="font-size:15px;line-height:1.55">' +
      "On the Pandoc conversion page:" +

      '<ol style="margin:6px 0 2px 20px;padding:0">' +
      "<li>Switch to <strong>Paste Text</strong>.</li>" +
      "<li>Paste (<kbd>Ctrl</kbd>+<kbd>V</kbd> or <kbd>Cmd</kbd>+<kbd>V</kbd>).</li>" +
      "<li>Set <strong>From:</strong> to <strong><code>html</code></strong>.</li>" +
      "<li>Choose the <strong>To</strong> format:</li>" +
      "</ol>" +

      '<div style="font-size:14px;line-height:1.6;margin:0 0 3px 20px">' +
      '<div><code>docx (Word)</code> <strong>— RECOMMENDED</strong></div>' +
      '<div>1. <code>odt (OpenDocument text)</code></div>' +
      '<div>2. <code>pdf (PDF via Typst)</code></div>' +
      "</div>" +

      '<ol start="5" style="margin:3px 0 8px 20px;padding:0">' +
      "<li>Click <strong>Convert</strong>.</li>" +
      "<li>When conversion finishes, click <strong>Download</strong>.</li>" +
      "</ol>" +

      '<div style="margin:12px 0 6px;font-size:14px;">' +
      '<strong>Important:</strong> Pandoc does <em>not</em> automatically add the file extension.<br>' +
      "When saving, manually name the file:" +
      "</div>" +

      '<div style="font-size:13px;line-height:1.7;margin-bottom:12px;">' +
      '<div><code style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:3px;">' +
      result.filenameDocx + "</code></div>" +
      '<div><code style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:3px;">' +
      result.filenameOdt + "</code></div>" +
      '<div><code style="background:rgba(255,255,255,0.2);padding:2px 6px;border-radius:3px;">' +
      result.filenamePdf + "</code></div>" +
      "</div>" +

      '<a href="https://pandoc.org/app/" target="_blank" rel="noopener" ' +
      'style="display:inline-block;padding:8px 16px;background:#fff;color:#198754;' +
      'font-weight:600;border-radius:6px;text-decoration:none">' +
      "Open Pandoc conversion site</a>" +

      "</div></div>" +

      '<button type="button" id="rl-banner-close" ' +
      'style="background:rgba(255,255,255,.25);border:none;color:#fff;' +
      'font-size:22px;width:36px;height:36px;border-radius:50%;cursor:pointer">' +
      "×</button></div>";

    banner.style.cssText =
      "position:fixed;top:24px;left:50%;transform:translateX(-50%);" +
      "z-index:100000;background:#198754;color:#fff;padding:22px 24px;" +
      "border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);" +
      "font-family:system-ui,sans-serif;max-width:560px;" +
      "width:calc(100% - 40px)";

    document.body.appendChild(banner);

    document.getElementById("rl-banner-close").addEventListener(
      "click",
      function () {
        banner.remove();
      }
    );
  }

  // ------------------------------------------------------------
  // DOWNLOAD BUTTON ACTION
  // ------------------------------------------------------------

  function onDownload(event) {
    event.preventDefault();
    event.stopPropagation();

    try {
      var result = extractContent();

      downloadBlob(
        result.filenameHtml,
        result.fullHtml
      );

      toast("Downloaded " + result.filenameHtml, true);

    } catch (err) {
      console.error(err);

      toast(
        err && err.message ? err.message : String(err),
        false
      );
    }
  }

  // ------------------------------------------------------------
  // COPY HTML AND OPEN PANDOC
  // ------------------------------------------------------------

  function onPandoc(event) {
    event.preventDefault();
    event.stopPropagation();

    var result;

    try {
      result = extractContent();

    } catch (err) {
      console.error(err);

      toast(
        err && err.message ? err.message : String(err),
        false
      );

      return;
    }

    var copy = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(result.pandocHtml)
      : Promise.reject(
          new Error("Clipboard is not available on this page")
        );

    copy.then(function () {
      window.open(
        "https://pandoc.org/app/",
        "_blank",
        "noopener"
      );

      showInstructionBanner(result);

    }).catch(function (err) {
      console.error(err);

      downloadBlob(
        result.filenameHtml,
        result.fullHtml
      );

      toast(
        "Clipboard blocked. Downloaded the HTML instead — open Pandoc and upload that file.",
        false
      );

      window.open(
        "https://pandoc.org/app/",
        "_blank",
        "noopener"
      );
    });
  }

  // ------------------------------------------------------------
  // ADD BUTTONS
  // ------------------------------------------------------------

  function addButtons() {
    if (document.getElementById("rl-extract-buttons")) return;

    var container = document.createElement("div");

    container.id = "rl-extract-buttons";

    container.style.cssText =
      "position:fixed;bottom:24px;right:24px;z-index:99999;" +
      "display:flex;flex-direction:column;gap:8px";

    var css =
      "padding:10px 16px;color:#fff;border:none;border-radius:8px;" +
      "font:13px/1.3 system-ui,sans-serif;cursor:pointer;" +
      "box-shadow:0 4px 12px rgba(0,0,0,.15);" +
      "text-align:left;max-width:280px";

    // Download HTML.
    var b1 = document.createElement("button");

    b1.type = "button";
    b1.textContent = "Extract and Download as .HTML";
    b1.title = "Downloads a clean HTML version of the document";
    b1.style.cssText = css + ";background:#0d6efd";
    b1.addEventListener("click", onDownload);

    // Copy HTML and open Pandoc.
    var b2 = document.createElement("button");

    b2.type = "button";
    b2.textContent = "Copy+Convert HTML via Pandoc";
    b2.title =
      "Copies the document HTML and opens Pandoc for conversion";

    b2.style.cssText = css + ";background:#198754";
    b2.addEventListener("click", onPandoc);

    // Auto-advance and download.
    autoButton = document.createElement("button");

    autoButton.type = "button";
    autoButton.textContent = "Auto-advance & Download HTML";
    autoButton.title =
      "Clicks Continue through interview sections, closes registration and Copilot popups, then downloads HTML";

    autoButton.style.cssText = css + ";background:#6f42c1";
    autoButton.addEventListener("click", onAutoAdvance);

    container.appendChild(b1);
    container.appendChild(b2);
    container.appendChild(autoButton);

    document.body.appendChild(container);

    if (observer) observer.disconnect();
  }

  // ------------------------------------------------------------
  // WATCH FOR DOCUMENT PREVIEW
  // ------------------------------------------------------------

  var observer = new MutationObserver(function () {
    if (
      document.querySelector("rocket-document") ||
      document.querySelector(".htmlGenerated")
    ) {
      addButtons();
    }
  });

  // ------------------------------------------------------------
  // START
  // ------------------------------------------------------------

  startLabelTracking();

  observer.observe(
    document.documentElement,
    {
      childList: true,
      subtree: true
    }
  );

  setTimeout(addButtons, 1500);

})();
