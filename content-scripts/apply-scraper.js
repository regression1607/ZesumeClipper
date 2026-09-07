// scraper.js - only acts when messaged by background.

(function () {
  if (window.__jobpilot_scraper_installed) return;
  window.__jobpilot_scraper_installed = true;

  // LinkedIn's Easy Apply footer buttons use these stable data-view-name
  // values. There are TWO naming families in the wild:
  //   - the "-unify" family: continue-unify / review-unify / submit-unify
  //   - the older "-application" family: review-application / submit-application
  // Single-page applies use submit-unify directly (no Next). Detect them all.
  const APPLY_FOOTER_SELECTOR =
    'button[data-view-name="continue-unify"], ' +
    'button[data-view-name="review-unify"], ' +
    'button[data-view-name="submit-unify"], ' +
    'button[data-view-name="review-application"], ' +
    'button[data-view-name="submit-application"]';

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) {
      // name is not a CSS selector; construct attribute selector
      const tag = el.tagName.toLowerCase();
      const sel = `${tag}[name="${CSS.escape(el.name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const path = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      let selector = node.tagName.toLowerCase();
      const parent = node.parentNode;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(selector);
      node = node.parentNode;
    }
    return path.join(" > ");
  }

  // LinkedIn Easy Apply wraps every question in a form-element container. The
  // human-readable question lives in that container's <label> or <legend>, not
  // necessarily adjacent to the input. Strip out error/hint/counter noise.
  const LI_FIELD_CONTAINER =
    ".fb-dash-form-element, [data-test-form-element], " +
    "[data-test-form-builder-radio-button-form-component], " +
    ".jobs-easy-apply-form-element, fieldset";

  function cleanLabelText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      // Remove common LinkedIn helper/counter/error suffixes.
      .replace(/\b\d+\s*\/\s*\d+\b/g, "") // "12/300" char counters
      .replace(/required$/i, "")
      .replace(/[*]+/g, "")
      .trim();
  }

  function labelFromContainer(el) {
    const container = el.closest(LI_FIELD_CONTAINER);
    if (!container) return "";
    // Prefer an explicit <label> or <legend> whose text is a real question.
    const labelNode =
      container.querySelector("label:not([class*='visually-hidden'])") ||
      container.querySelector("legend") ||
      container.querySelector("label");
    if (labelNode) {
      // Clone and drop nested error / hint / counter nodes before reading text.
      const clone = labelNode.cloneNode(true);
      clone
        .querySelectorAll(
          "[class*='error'], [class*='inline-feedback'], [class*='counter'], [class*='visually-hidden'], .t-black--light"
        )
        .forEach((n) => n.remove());
      const t = cleanLabelText(clone.textContent);
      if (t) return t;
    }
    return "";
  }

  function labelFor(el) {
    // 1) LinkedIn form-element container label / fieldset legend (most reliable).
    const containerLabel = labelFromContainer(el);
    if (containerLabel) return containerLabel;

    // 2) <label for="id">
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent) return cleanLabelText(l.textContent);
    }
    // 3) wrapping label
    const wrap = el.closest("label");
    if (wrap && wrap.textContent) return cleanLabelText(wrap.textContent);
    // 4) aria-label
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    // 5) aria-labelledby (may reference multiple space-separated IDs)
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      const t = cleanLabelText(text);
      if (t) return t;
    }
    // 6) placeholder
    if (el.placeholder) return el.placeholder.trim();
    // 7) nearest previous text
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++) {
      const t = (prev.textContent || "").trim();
      if (t) return cleanLabelText(t);
      prev = prev.previousElementSibling;
    }
    // 8) parent text
    const parentText = (el.parentElement?.textContent || "").trim();
    return cleanLabelText(parentText).slice(0, 120);
  }

  // Returns the visible validation error text for a field, or "" if none.
  function fieldErrorFor(el) {
    const container = el.closest(LI_FIELD_CONTAINER);
    if (!container) return "";
    const errNode = container.querySelector(
      ".artdeco-inline-feedback--error, [class*='error-field'], [class*='__error'], [role='alert']"
    );
    if (errNode && isVisible(errNode)) {
      const t = (errNode.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 160);
    }
    return "";
  }

  function isRequired(el) {
    if (el.required) return true;
    if (el.getAttribute("aria-required") === "true") return true;
    const container = el.closest(LI_FIELD_CONTAINER);
    if (container && /\*|\brequired\b/i.test(container.querySelector("label, legend")?.textContent || "")) {
      return true;
    }
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function scrapeListings() {
    // Only pick up Easy Apply / Easily apply listings — external ATS redirects
    // are unreliable to automate.
    const EASY_APPLY_RE = /easy\s?apply|easily\s?apply/i;
    const jobs = [];
    const seen = new Set();
    let inspected = 0;
    let rejectedNonEasy = 0;

    // LinkedIn renders each title twice (a visible aria-hidden span + a
    // visually-hidden duplicate), producing "TitleTitle". Collapse that.
    const dedupeText = (raw) => {
      let t = String(raw || "").replace(/\s+/g, " ").trim();
      const half = t.length / 2;
      if (Number.isInteger(half) && t.slice(0, half) === t.slice(half)) {
        t = t.slice(0, half).trim();
      }
      return t;
    };

    const cardTitle = (a) => {
      const ariaSpan = a.querySelector('span[aria-hidden="true"]');
      const t = dedupeText(ariaSpan?.textContent || a.textContent || "");
      return t.split("\n")[0].trim().slice(0, 160);
    };

    const cardCompany = (card) => {
      const el = card.querySelector(
        '.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, ' +
        '[class*="primary-description"], .job-card-container__company-name'
      );
      return dedupeText(el?.textContent || "").slice(0, 120);
    };

    const cardLocation = (card) => {
      const el = card.querySelector(
        '.job-card-container__metadata-item, [class*="metadata-item"], ' +
        '.artdeco-entity-lockup__caption'
      );
      return dedupeText(el?.textContent || "").slice(0, 120);
    };

    // Normalize to a clean standalone job URL when a job id is present, so we
    // open the real job page rather than a search/collections view.
    const normalizeJobUrl = (href) => {
      try {
        const u = new URL(href, location.href);
        const m = /\/jobs\/view\/(\d+)/.exec(u.pathname) ||
          [null, u.searchParams.get("currentJobId")];
        const id = m && m[1];
        if (id && /^\d+$/.test(id)) {
          return `https://www.linkedin.com/jobs/view/${id}/`;
        }
        return u.href;
      } catch (_) {
        return href;
      }
    };

    // 1) LinkedIn: target /jobs/view/ anchors directly.
    // 2) Indeed: target /viewjob or /clk anchors.
    // 3) Generic fallback: anchors whose URL suggests a job.
    const anchors = Array.from(document.querySelectorAll("a[href]")).filter((a) => {
      const h = a.href || "";
      return /\/jobs\/view\/|\/viewjob|\/clk|\/job\/|\/careers\/|\/positions?\//i.test(h) ||
             /job|position|opening|posting/i.test(h);
    });

    for (const a of anchors) {
      const href = a.href;
      if (!href) continue;
      const url = normalizeJobUrl(href);
      if (seen.has(url)) continue;

      // Walk up until we find a container big enough to include the whole card
      // (title + company + Easy Apply badge). LinkedIn's new UI wraps each
      // listing in an <li>, sometimes deeply nested.
      let card = a.closest("li, article, [data-view-name], [data-occludable-job-id]");
      if (!card) card = a.parentElement;
      // Expand outward if container looks too small.
      let hops = 0;
      while (card && card.parentElement && card.textContent.length < 60 && hops < 4) {
        card = card.parentElement;
        hops++;
      }
      if (!card) continue;

      const cardText = card.textContent || "";
      // Skip navigational anchors / breadcrumbs that don't look like a listing.
      if (cardText.trim().length < 20) continue;

      inspected++;

      if (!EASY_APPLY_RE.test(cardText)) {
        rejectedNonEasy++;
        continue;
      }

      const title = cardTitle(a);
      if (title.length < 3) continue;

      seen.add(url);
      jobs.push({
        title,
        company: cardCompany(card),
        location: cardLocation(card),
        description: cardText.replace(/\s+/g, " ").trim().slice(0, 400),
        url,
        easyApply: true
      });
      if (jobs.length >= 40) break;
    }
    return { jobs, meta: { inspected, rejectedNonEasy, easyApplyOnly: true } };
  }

  // -------- LinkedIn Easy Apply support --------

  function getAnyVisibleDialog() {
    return Array.from(
      document.querySelectorAll(
        '[role="dialog"], .jobs-easy-apply-modal, .artdeco-modal, ' +
        '[data-test-modal], [data-test-modal-id], .artdeco-modal--layer-default'
      )
    ).filter(isVisible);
  }

  // Structural markers LinkedIn uses for the Easy Apply dialog (independent of
  // the footer button text, which changes between steps and locales).
  function isEasyApplyModal(el) {
    if (!el) return false;
    if (
      el.querySelector(
        '.jobs-easy-apply-content, .jobs-easy-apply-form-section__grouping, ' +
        '[data-test-modal-id="easy-apply-modal"], [class*="jobs-easy-apply"], ' +
        '[id*="easy-apply"], [id*="jobs-apply"]'
      )
    ) {
      return true;
    }
    const header = el.querySelector(
      'h2, h1, [role="heading"], .artdeco-modal__header'
    );
    const htext = (header?.textContent || "").trim();
    if (
      /apply to |add your |your application|contact info|work experience|resume|additional questions/i.test(
        htext
      )
    ) {
      return true;
    }
    return false;
  }

  // Returns true only if the page has an Easy Apply-style primary action
  // button (Next / Review / Submit application) — this is the reliable
  // signal that we're actually inside the Easy Apply flow.
  function hasEasyApplyPrimary() {
    // Fast: LinkedIn's stable data-view-name attributes.
    if (document.querySelector(APPLY_FOOTER_SELECTOR)) return true;
    // Fallback: any visible button whose text matches the Easy Apply footer.
    return Array.from(document.querySelectorAll("button")).some((b) => {
      if (!isVisible(b) || b.disabled) return false;
      const t = (b.textContent || "").trim();
      const aria = (b.getAttribute("aria-label") || "").trim();
      if (/easy apply to this job/i.test(aria)) return false; // the "Easy Apply" trigger itself
      return /submit application|^review$|review your application|continue to next|^next$|^continue$/i.test(t) ||
             /submit application|review your application|continue to next/i.test(aria);
    });
  }

  // The stable anchor for the Easy Apply flow across LinkedIn's modal AND the
  // newer inline/overlay variants (obfuscated class names, no role="dialog").
  // NOTE: include DISABLED buttons — LinkedIn disables the footer button and
  // shows a spinner while loading the next step, and we must NOT treat that
  // brief loading state as "the flow closed".
  function getEasyApplyFooterButton() {
    const candidates = Array.from(document.querySelectorAll(APPLY_FOOTER_SELECTOR));
    return candidates.find((b) => isVisible(b)) || null;
  }

  function getLinkedInApplyRoot() {
    // Modern LinkedIn renders Easy Apply either as an overlay or inline on the
    // page — frequently with NO role="dialog" / .artdeco-modal wrapper (class
    // names are hashed). The only reliable signal is the footer button's stable
    // data-view-name. Climb from it to the nearest ancestor holding the form.
    const footer = getEasyApplyFooterButton();
    if (footer) {
      let node = footer.parentElement;
      let withFields = null;
      let hops = 0;
      while (node && node !== document.body && hops < 20) {
        const cls = (node.className || "").toString();
        if (node.getAttribute("role") === "dialog" || /modal/i.test(cls)) {
          return node;
        }
        // Remember the closest ancestor that actually contains form inputs.
        if (!withFields && node.querySelector("input, textarea, select")) {
          withFields = node;
        }
        node = node.parentElement;
        hops++;
      }
      if (withFields) return withFields;
      // Apply flow is open but this step may have no inputs yet (e.g. a resume
      // review step that only has a "Next" button): return a stable ancestor so
      // the orchestrator can still click through.
      return footer.closest("form, section, div") || footer.parentElement || document.body;
    }

    // Legacy dialog detection (older LinkedIn UI).
    const dialogs = getAnyVisibleDialog();
    for (const d of dialogs) {
      if (isEasyApplyModal(d)) return d;
      if (d.querySelector("input, textarea, select")) return d;
    }

    // Full-page flow at /jobs/view/{id}/apply/.
    if (/\/jobs\/view\/\d+\/apply/i.test(location.pathname)) {
      if (document.body.querySelector("input, textarea, select")) return document.body;
    }
    return null;
  }

  function getLinkedInModal() {
    return getLinkedInApplyRoot();
  }

  async function dismissNonFormDialogs() {
    // "Job safety reminder" / "Continue applying" pre-dialogs have no form
    // fields — click their Continue/OK button so we can reach the real modal.
    const dialogs = getAnyVisibleDialog().filter(
      (d) => !d.querySelector("input, textarea, select")
    );
    let clicked = false;
    for (const d of dialogs) {
      const btn = Array.from(d.querySelectorAll("button")).find((b) => {
        const t = (b.textContent || "").trim();
        return /continue applying|continue|got it|i understand|^ok$/i.test(t) &&
               !/cancel|dismiss|not now/i.test(t) &&
               isVisible(b) && !b.disabled;
      });
      if (btn) {
        btn.click();
        clicked = true;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    return clicked;
  }

  function findEasyApplyOpenButton() {
    // Preferred: LinkedIn's dedicated apply button selectors.
    const preferred = Array.from(
      document.querySelectorAll(
        'button.jobs-apply-button, ' +
        'button[data-live-test-job-apply-button], ' +
        'button[aria-label^="Easy Apply"], ' +
        'button[aria-label*="Easy Apply to"]'
      )
    ).filter((b) => isVisible(b) && !b.disabled);
    for (const b of preferred) {
      const aria = (b.getAttribute("aria-label") || "").trim();
      const txt = (b.textContent || "").trim();
      if (/company (?:website|site)/i.test(aria) || /company (?:website|site)/i.test(txt)) continue;
      return b;
    }
    // Fallback: any button whose text starts with "Easy Apply" and is big enough.
    const buttons = Array.from(document.querySelectorAll("button"));
    return (
      buttons.find((b) => {
        const t = (b.textContent || "").trim();
        const aria = (b.getAttribute("aria-label") || "").trim();
        const easy = /^easy apply/i.test(t) || /easy apply/i.test(aria);
        const external = /company (?:website|site)/i.test(t) || /company (?:website|site)/i.test(aria);
        const rect = b.getBoundingClientRect();
        const bigEnough = rect.width > 60 && rect.height > 20;
        return easy && !external && bigEnough && isVisible(b) && !b.disabled;
      }) || null
    );
  }

  function findModalPrimaryButton(modal) {
    if (!modal) return null;
    // Prefer LinkedIn's stable data-view-name attributes.
    // Search both inside the modal scope AND at document scope, because
    // LinkedIn sometimes renders footer buttons outside the form container.
    const byDataAttr = [
      { sel: '[data-view-name="submit-application"]', kind: "submit" },
      { sel: '[data-view-name="submit-unify"]', kind: "submit" },
      { sel: '[data-view-name="review-application"]', kind: "review" },
      { sel: '[data-view-name="review-unify"]', kind: "review" },
      { sel: '[data-view-name="continue-unify"]', kind: "next" }
    ];
    for (const { sel, kind } of byDataAttr) {
      const el = modal.querySelector(sel) || document.querySelector(sel);
      if (el && isVisible(el) && !el.disabled) {
        const label =
          (el.textContent || "").trim() ||
          (el.getAttribute("aria-label") || "").trim();
        return { el, label: label || kind, kind };
      }
    }

    // Fallback: text/aria-based match across BOTH the modal scope and the
    // whole document (LinkedIn's footer buttons — Next / Submit — are often
    // rendered outside the form container). Dedup by element identity.
    const bucket = new Set();
    for (const b of modal.querySelectorAll("button")) bucket.add(b);
    for (const b of document.querySelectorAll("button")) bucket.add(b);
    const buttons = Array.from(bucket).filter(
      (b) => isVisible(b) && !b.disabled && b.getBoundingClientRect().width > 30
    );
    const rank = (t, aria) => {
      const s = `${t} ${aria}`.trim();
      if (/submit application/i.test(s)) return 4;
      if (/^review$/i.test(t) || /review your application/i.test(s)) return 3;
      if (/continue to next|^next$|^continue$/i.test(t)) return 2;
      if (/dismiss|close|discard|back to|previous|save (draft|for later)|jump menu/i.test(s)) return -1;
      return 0;
    };
    let best = null;
    let bestRank = 0;
    for (const b of buttons) {
      const label = (b.textContent || "").trim();
      const aria = (b.getAttribute("aria-label") || "").trim();
      const r = rank(label, aria);
      if (r > bestRank) {
        best = { el: b, label, kind: r === 4 ? "submit" : r === 3 ? "review" : r === 2 ? "next" : "other" };
        bestRank = r;
      }
    }
    return best;
  }

  function dumpButtons() {
    return Array.from(document.querySelectorAll("button")).map((b, i) => {
      const rect = b.getBoundingClientRect();
      return {
        i,
        text: (b.textContent || "").trim().slice(0, 100),
        aria: (b.getAttribute("aria-label") || "").slice(0, 120),
        cls: (b.className || "").toString().slice(0, 140),
        id: b.id || "",
        dataAttrs: Array.from(b.attributes)
          .filter((a) => a.name.startsWith("data-"))
          .map((a) => `${a.name}=${a.value.slice(0, 40)}`)
          .slice(0, 4),
        visible: isVisible(b),
        disabled: !!b.disabled,
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      };
    });
  }

  function dumpDialogs() {
    return getAnyVisibleDialog().map((d) => ({
      cls: (d.className || "").toString().slice(0, 140),
      role: d.getAttribute("role") || "",
      aria: (d.getAttribute("aria-label") || d.getAttribute("aria-labelledby") || "").slice(0, 120),
      hasFields: !!d.querySelector("input, textarea, select"),
      textSample: (d.textContent || "").trim().slice(0, 200),
      buttons: Array.from(d.querySelectorAll("button")).map((b) => ({
        text: (b.textContent || "").trim().slice(0, 80),
        aria: (b.getAttribute("aria-label") || "").slice(0, 80)
      }))
    }));
  }

  async function linkedinOpenEasyApply() {
    if (getLinkedInModal()) return { ok: true, alreadyOpen: true };
    const btn = findEasyApplyOpenButton();
    if (!btn) {
      return {
        ok: false,
        reason: "no-easy-apply-button",
        pageTitle: document.title,
        url: location.href,
        allButtons: dumpButtons(),
        dialogs: dumpDialogs()
      };
    }

    const startHost = location.hostname;
    let clicks = 0;
    try { btn.scrollIntoView({ block: "center" }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
    btn.click();
    clicks++;

    const start = Date.now();
    let safetyDismissed = false;
    while (Date.now() - start < 25000) {
      await new Promise((r) => setTimeout(r, 300));

      // If clicking the apply button navigated us off LinkedIn, it's an
      // external ATS redirect — not automatable here.
      if (location.hostname && location.hostname !== startHost &&
          !/(^|\.)linkedin\.com$/i.test(location.hostname)) {
        return { ok: false, reason: "external-redirect", url: location.href };
      }

      if (!safetyDismissed) {
        safetyDismissed = await dismissNonFormDialogs();
      }
      // Either the classic modal appeared OR we navigated to /apply/ full-page flow.
      if (getLinkedInApplyRoot()) return { ok: true, safetyDismissed, url: location.href };

      // Re-click once mid-way if nothing happened (first click sometimes gets
      // swallowed while the job card is still hydrating).
      if (clicks < 2 && Date.now() - start > 6000) {
        const again = findEasyApplyOpenButton();
        if (again) {
          try { again.click(); } catch (_) {}
          clicks++;
        }
      }
    }
    return {
      ok: false,
      reason: "modal-did-not-open",
      pageTitle: document.title,
      url: location.href,
      clickedButtonText: (btn.textContent || "").trim().slice(0, 80),
      clickedButtonAria: (btn.getAttribute("aria-label") || "").slice(0, 100),
      clickedButtonCls: (btn.className || "").toString().slice(0, 140),
      clicks,
      safetyDismissed,
      dialogs: dumpDialogs(),
      allButtons: dumpButtons()
    };
  }

  function linkedinModalState() {
    const modal = getLinkedInModal();
    if (!modal) return { inModal: false, confirmed: linkedinApplicationConfirmed() };
    const primary = findModalPrimaryButton(modal);
    // Scrape only fields inside the modal.
    const fields = scrapeFieldsIn(modal);
    return {
      inModal: true,
      fields,
      primaryButtonText: primary?.label || null,
      primaryKind: primary?.kind || null,
      modalText: (modal.textContent || "").trim().slice(0, 400)
    };
  }

  // True only when LinkedIn shows the post-submit confirmation ("Your
  // application was sent to ..."). Used to avoid falsely logging "Applied".
  function linkedinApplicationConfirmed() {
    const body = (document.body.innerText || "");
    if (/your application was sent|application was sent to|your application has been submitted|application submitted|application sent/i.test(body)) {
      return true;
    }
    // The confirmation dialog has a "Done" button and a success headline.
    const dialogs = getAnyVisibleDialog();
    for (const d of dialogs) {
      const t = (d.textContent || "");
      if (/application was sent|application sent|done/i.test(t) &&
          !d.querySelector(APPLY_FOOTER_SELECTOR)) {
        if (/application was sent|application sent/i.test(t)) return true;
      }
    }
    return false;
  }

  // A signature of the current step: primary button + the set of field
  // selectors. Changes when LinkedIn advances to a different step.
  function stepSignature(root) {
    try {
      const fields = scrapeFieldsIn(root).map((f) => f.selector).sort().join("|");
      const primary = findModalPrimaryButton(root);
      return `${primary?.kind || ""}::${primary?.label || ""}::${fields}`;
    } catch (_) {
      return "";
    }
  }

  async function linkedinClickPrimary() {
    const modal = getLinkedInModal();
    if (!modal) return { ok: false, reason: "no-modal", allButtons: dumpButtons(), url: location.href };
    const primary = findModalPrimaryButton(modal);
    if (!primary) return {
      ok: false,
      reason: "no-primary-button",
      url: location.href,
      pageTitle: document.title,
      modalTag: modal.tagName,
      modalCls: (modal.className || "").toString().slice(0, 200),
      allButtons: dumpButtons()
    };
    const beforeLabel = primary.label;
    const beforeSig = stepSignature(modal);
    primary.el.click();

    const start = Date.now();
    while (Date.now() - start < 12000) {
      await new Promise((r) => setTimeout(r, 250));

      if (!getLinkedInModal()) {
        // Apply root vanished. This could be a re-render OR loading (footer
        // button counts even when disabled). Confirm it's truly gone before
        // deciding the flow closed.
        let gone = true;
        for (let k = 0; k < 8; k++) {
          await new Promise((r) => setTimeout(r, 200));
          if (getLinkedInModal()) { gone = false; break; }
        }
        if (gone) {
          const confirmed = linkedinApplicationConfirmed();
          return { ok: true, clicked: beforeLabel, kind: primary.kind, closed: true, confirmed };
        }
        continue;
      }

      // Still in the flow. Only treat as "advanced" once there's an ENABLED
      // primary again (i.e. the next step finished loading) AND the step
      // content changed. This avoids reacting to the disabled loading state.
      const cur = getLinkedInModal();
      const curPrimary = findModalPrimaryButton(cur); // enabled-only
      if (curPrimary) {
        const curSig = stepSignature(cur);
        if (curSig !== beforeSig) {
          return { ok: true, clicked: beforeLabel, kind: primary.kind, closed: false };
        }
      }
    }
    // Timed out. If the modal is still present, report not-closed so the loop
    // re-evaluates the current step.
    const stillGone = !getLinkedInModal();
    return {
      ok: true,
      clicked: beforeLabel,
      kind: primary.kind,
      closed: stillGone,
      confirmed: stillGone ? linkedinApplicationConfirmed() : false,
      stalled: true
    };
  }

  function currentFieldValue(el) {
    const type = (el.type || el.tagName).toLowerCase();
    if (type === "checkbox") return el.checked ? true : "";
    if (type === "radio") {
      if (!el.name) return el.checked ? el.value : "";
      const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`);
      const sel = Array.from(group).find((r) => r.checked);
      return sel ? sel.value : "";
    }
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      if (!opt) return "";
      const t = (opt.textContent || "").trim();
      if (/^(select|choose|please|--)/i.test(t.toLowerCase())) return "";
      return opt.value || "";
    }
    return (el.value || "").toString();
  }

  // The immediate label of a single radio/checkbox OPTION (e.g. "Yes"), NOT the
  // question. Deliberately avoids climbing to the fieldset legend.
  function optionLabelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent && l.textContent.trim()) return l.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
      const t = (clone.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    const next = el.nextElementSibling;
    if (next && (next.textContent || "").trim()) return next.textContent.trim();
    return (el.value || "").trim();
  }

  function scrapeFieldsIn(root) {
    const fields = [];
    const seenSelectors = new Set();
    const seenRadioGroups = new Set();
    const els = root.querySelectorAll("input, textarea, select");
    for (const el of els) {
      if (!isVisible(el)) continue;
      const type = (el.type || el.tagName).toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;

      // Collapse a radio group into a single field (one question, N options).
      if (type === "radio" && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);
      }

      const selector = cssPath(el);
      if (!selector || seenSelectors.has(selector)) continue;
      seenSelectors.add(selector);

      const field = {
        selector,
        label: labelFor(el).replace(/\s+/g, " ").slice(0, 240),
        type,
        required: isRequired(el),
        name: el.name || "",
        currentValue: currentFieldValue(el),
        error: fieldErrorFor(el),
        options: undefined
      };
      if (el.tagName === "SELECT") {
        field.options = Array.from(el.options)
          .map((o) => o.textContent.trim())
          .filter((t) => t && !/^(select|choose|please|--)/i.test(t.toLowerCase()));
      } else if (type === "radio" || type === "checkbox") {
        if (el.name) {
          const group = root.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`);
          // Use each option's OWN label (Yes/No/...), not the question.
          field.options = Array.from(group).map((g) => optionLabelFor(g));
        }
      }
      fields.push(field);
    }
    return fields;
  }

  function scrapeForm() {
    // Prefer LinkedIn modal if present.
    const modal = getLinkedInModal();
    if (modal) return { fields: scrapeFieldsIn(modal), url: location.href, source: "linkedin-modal" };
    const forms = Array.from(document.querySelectorAll("form")).filter(isVisible);
    const targets = forms.length > 0 ? forms : [document.body];
    const fields = [];
    const seenSelectors = new Set();

    for (const form of targets) {
      const els = form.querySelectorAll("input, textarea, select");
      for (const el of els) {
        if (!isVisible(el)) continue;
        const type = (el.type || el.tagName).toLowerCase();
        if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) {
          if (type === "file") {
            // still surface resume upload requirement
          } else {
            continue;
          }
        }

        const selector = cssPath(el);
        if (!selector || seenSelectors.has(selector)) continue;
        seenSelectors.add(selector);

        const field = {
          selector,
          label: labelFor(el).replace(/\s+/g, " ").slice(0, 240),
          type,
          required: !!el.required,
          name: el.name || "",
          options: undefined
        };

        if (el.tagName === "SELECT") {
          field.options = Array.from(el.options).map((o) => o.textContent.trim());
        } else if (type === "radio" || type === "checkbox") {
          // gather sibling radios by name
          if (el.name) {
            const group = form.querySelectorAll(
              `input[name="${CSS.escape(el.name)}"]`
            );
            field.options = Array.from(group).map((g) => {
              const lbl = labelFor(g);
              return lbl || g.value;
            });
          }
        }

        fields.push(field);
      }
    }

    return { fields, url: location.href };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    (async () => {
      try {
        if (msg.type === "scrapeListings") {
          sendResponse(scrapeListings());
        } else if (msg.type === "scrapeForm") {
          sendResponse(scrapeForm());
        } else if (msg.type === "linkedinOpenEasyApply") {
          sendResponse(await linkedinOpenEasyApply());
        } else if (msg.type === "linkedinModalState") {
          sendResponse(linkedinModalState());
        } else if (msg.type === "linkedinClickPrimary") {
          sendResponse(await linkedinClickPrimary());
        }
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  });
})();
