// submitter.js
(function () {
  if (window.__jobpilot_submitter_installed) return;
  window.__jobpilot_submitter_installed = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== "submitForm") return;
    sendResponse({ confirmed: false, note: 'manual-submission-required' });
    return false;
  });
})();
