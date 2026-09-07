// dock.js — injects the Zesume Clipper panel as a docked side panel that takes
// the right 20% of the screen and shifts the page content to the left 80%.
// Toggled by the toolbar icon (via a message from the background worker).
(function () {
  if (window.__zesume_dock_installed) return;
  window.__zesume_dock_installed = true;

  const DOCK_ID = "zesume-clipper-dock";
  const WIDTH = "22%"; // right-hand panel width (page reflows to the rest)
  const SHIFT_PROP = "--zesume-dock-shift";

  function isOpen() {
    return !!document.getElementById(DOCK_ID);
  }

  function openDock() {
    if (isOpen()) return;

    const frame = document.createElement("iframe");
    frame.id = DOCK_ID;
    frame.src = chrome.runtime.getURL("popup/popup.html");
    Object.assign(frame.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: WIDTH,
      height: "100vh",
      border: "none",
      borderLeft: "1px solid rgba(0,0,0,0.12)",
      boxShadow: "-8px 0 24px -12px rgba(0,0,0,0.25)",
      zIndex: "2147483647",
      background: "#f3f2ef",
      colorScheme: "light",
    });
    document.documentElement.appendChild(frame);

    // Shift the whole page to the left 78% by reserving right margin.
    const root = document.documentElement;
    root.style.transition = "margin-right 0.18s ease";
    root.style.marginRight = WIDTH;
  }

  function closeDock() {
    const frame = document.getElementById(DOCK_ID);
    if (frame) frame.remove();
    document.documentElement.style.marginRight = "";
  }

  function toggleDock() {
    if (isOpen()) closeDock();
    else openDock();
  }

  // Toggle when the toolbar icon is clicked (background relays this).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "toggle-dock") {
      toggleDock();
      sendResponse({ ok: true, open: isOpen() });
    }
    return true;
  });

  // Close request from inside the panel iframe.
  window.addEventListener("message", (e) => {
    if (e?.data?.type === "zesume-dock-close") closeDock();
  });
})();
