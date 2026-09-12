// filler.js
(function () {
  if (window.__jobpilot_filler_installed) return;
  window.__jobpilot_filler_installed = true;

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
                  el.tagName === "SELECT" ? HTMLSelectElement.prototype :
                  HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  // Reliably check a radio/checkbox for React-controlled forms (LinkedIn).
  // A raw `el.checked = true` bypasses React's internal value tracker, so the
  // framework reverts it on the next render and validation still fails. Firing
  // a real `.click()` runs the user-gesture path React listens to, then we set
  // the native checked value and dispatch input/change as a belt-and-braces.
  function checkInput(el) {
    try { el.focus({ preventScroll: true }); } catch (_) {}
    if (!el.checked) {
      try { el.click(); } catch (_) {}
    }
    if (!el.checked) {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      if (desc && desc.set) desc.set.call(el, true);
      else el.checked = true;
    }
    fire(el, "input");
    fire(el, "change");
  }

  function labelTextFor(r) {
    const byFor = r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent;
    const raw = byFor || r.closest("label")?.textContent || r.value || "";
    return raw.replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Find the radio/checkbox in a group that best matches the desired value,
  // with fuzzy + Yes/No coercion so answers like "Yes, I do" hit the "Yes" opt.
  function matchOption(group, value) {
    const want = String(value).replace(/\s+/g, " ").trim().toLowerCase();
    const list = Array.from(group);
    // 1) exact label or value match
    let hit = list.find((r) => labelTextFor(r) === want || (r.value || "").toLowerCase() === want);
    if (hit) return hit;
    // 2) substring either direction
    hit = list.find((r) => {
      const t = labelTextFor(r);
      return t && (t.includes(want) || want.includes(t));
    });
    if (hit) return hit;
    // 3) boolean coercion (yes/true/1  •  no/false/0)
    const truthy = /^(yes|y|true|1|agree|i (do|have|am))/.test(want);
    const falsy = /^(no|n|false|0|disagree)/.test(want);
    if (truthy || falsy) {
      hit = list.find((r) => {
        const t = labelTextFor(r);
        return (truthy && /^yes\b/.test(t)) || (falsy && /^no\b/.test(t));
      });
      if (hit) return hit;
    }
    return null;
  }

  function isAlreadyFilled(el) {
    const type = (el.type || el.tagName).toLowerCase();
    if (type === "checkbox") {
      // Only respect an existing checked state; unchecked is treated as "empty".
      return el.checked === true;
    }
    if (type === "radio") {
      const name = el.name;
      if (!name) return el.checked === true;
      const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
      return Array.from(group).some((r) => r.checked);
    }
    if (el.tagName === "SELECT") {
      // Consider filled if a non-placeholder option is selected.
      const opt = el.options[el.selectedIndex];
      if (!opt) return false;
      const v = (opt.value || "").trim();
      const t = (opt.textContent || "").trim().toLowerCase();
      if (!v) return false;
      if (/^(select|choose|please|--)/i.test(t)) return false;
      return true;
    }
    // input / textarea
    return typeof el.value === "string" && el.value.trim().length > 0;
  }

  function fillOne({ selector, value }) {
    let el;
    try {
      el = document.querySelector(selector);
    } catch {
      return { selector, ok: false, reason: "bad-selector" };
    }
    if (!el) return { selector, ok: false, reason: "not-found" };

    const type = (el.type || el.tagName).toLowerCase();

    // Preserve existing text/select values (e.g. LinkedIn pre-fill). Radios and
    // checkboxes are handled inside their branches so we can switch a wrong
    // pre-selection to the value the LLM chose.
    if (type !== "radio" && type !== "checkbox" && isAlreadyFilled(el)) {
      return { selector, ok: true, skipped: "already-filled" };
    }

    try {
      if (type === "checkbox") {
        const want = value === true || /^(true|yes|1|on)$/i.test(String(value));
        if (want) {
          checkInput(el);
        } else if (el.checked) {
          try { el.click(); } catch (_) {}
          fire(el, "input");
          fire(el, "change");
        }
      } else if (type === "radio") {
        const name = el.name;
        const group = name
          ? document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
          : [el];
        const target = matchOption(group, value) || el;
        // Already correct? Nothing to do.
        if (target.checked) return { selector, ok: true, skipped: "already-correct" };
        checkInput(target);
        return { selector, ok: true, matched: labelTextFor(target) };
      } else if (el.tagName === "SELECT") {
        const wanted = String(value).trim().toLowerCase();
        const opt = Array.from(el.options).find(
          (o) => o.textContent.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted
        );
        if (opt) {
          el.value = opt.value;
          fire(el, "input");
          fire(el, "change");
        } else {
          return { selector, ok: false, reason: "no-matching-option" };
        }
      } else {
        setNativeValue(el, String(value ?? ""));
        fire(el, "input");
        fire(el, "change");
        fire(el, "blur");
      }
      return { selector, ok: true };
    } catch (e) {
      return { selector, ok: false, reason: e.message };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "fillForm") return;
    const results = (msg.fills || []).map(fillOne);
    sendResponse({ results });
    return true;
  });
})();
