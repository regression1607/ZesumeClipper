// submitter.js
(function () {
  if (window.__jobpilot_submitter_installed) return;
  window.__jobpilot_submitter_installed = true;

  function findSubmitButton() {
    // Prefer explicit submit buttons in visible forms
    const explicit = document.querySelector('form button[type="submit"], form input[type="submit"]');
    if (explicit && !explicit.disabled) return explicit;

    const dataTestBtn = document.querySelector(
      'button[data-test*="send"], button[data-test*="submit"], button[data-test*="apply"]'
    );
    if (dataTestBtn && !dataTestBtn.disabled) return dataTestBtn;

    const buttons = Array.from(document.querySelectorAll('button, input[type="button"], a[role="button"]'));
    const textMatches = /^(submit|apply|send application|send|submit application|apply now)$/i;
    const partialMatches = /(submit|apply|send)/i;

    const exact = buttons.find((b) => {
      const t = (b.textContent || b.value || "").trim();
      return textMatches.test(t);
    });
    if (exact) return exact;

    const partial = buttons.find((b) => {
      const t = (b.textContent || b.value || "").trim();
      return partialMatches.test(t);
    });
    return partial || null;
  }

  async function waitForSuccess(timeoutMs = 8000) {
    const startUrl = location.href;
    const successRe = /(thank you|application (?:submitted|received|sent)|successfully applied|your application has been sent|we('| have)? received|application complete)/i;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (location.href !== startUrl) return { confirmed: true, note: "url-change" };
      if (successRe.test(document.body.innerText || "")) return { confirmed: true, note: "success-text" };
      await new Promise((r) => setTimeout(r, 400));
    }
    return { confirmed: false, note: "no-confirmation-detected" };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "submitForm") return;
    (async () => {
      const btn = msg.selector ? document.querySelector(msg.selector) : findSubmitButton();
      if (!btn) {
        sendResponse({ confirmed: false, note: "submit-button-not-found" });
        return;
      }
      try {
        btn.click();
      } catch (e) {
        sendResponse({ confirmed: false, note: `click-error: ${e.message}` });
        return;
      }
      const result = await waitForSuccess();
      sendResponse(result);
    })();
    return true;
  });
})();
