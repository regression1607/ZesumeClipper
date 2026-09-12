// jd-scraper.js — extracts the job description, title, and company from the
// current page. Only acts when messaged by the popup/background. Reuses the
// robust visible-text extraction approach from JobPilotAssist.
(function () {
  if (window.__zesume_clipper_installed) return;
  window.__zesume_clipper_installed = true;

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

  function clean(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  // Lines that are page chrome / navigation, not part of the job description.
  const JUNK_LINE = new RegExp(
    "^(" +
      "\\d+\\s+notifications?|" +
      "skip to (search|main content|primary content|aside|footer|content|navigation)|" +
      "close jump menu|open jump menu|" +
      "home|my network|jobs|messaging|notifications|me|for business|" +
      "try premium( for free)?|premium|" +
      "sign in|join now|" +
      "add a note|more options|see more|show more|show less|" +
      "skip to the main content|" +
      "\\W*" + // lone punctuation / bullets
    ")$",
    "i"
  );

  // Strip leading/embedded navigation boilerplate from scraped text.
  function stripBoilerplate(text) {
    const lines = String(text || "").split("\n");
    const kept = lines.filter((raw) => {
      const t = raw.trim();
      if (!t) return true; // keep blank lines for paragraph spacing
      if (JUNK_LINE.test(t)) return false;
      return true;
    });
    // Drop leading blanks/short nav fragments until real content starts.
    while (kept.length && kept[0].trim().length < 2) kept.shift();
    return clean(kept.join("\n"));
  }

  function textOf(el) {
    if (!el || !isVisible(el)) return "";
    // Prefer innerText (respects visibility / line breaks) over textContent.
    return clean(el.innerText || el.textContent || "");
  }

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const t = textOf(el);
        if (t && t.length > 40) return t;
      }
    }
    return "";
  }

  // Known job-description containers across major boards / ATS platforms.
  const JD_SELECTORS = [
    // LinkedIn
    ".jobs-description__content",
    ".jobs-box__html-content",
    "#job-details",
    ".jobs-description-content__text",
    ".show-more-less-html__markup",
    // Indeed
    "#jobDescriptionText",
    // Greenhouse
    "#content .body",
    "#job_description",
    // Lever
    ".posting-page .section-wrapper",
    ".posting-requirements",
    // Wellfound (AngelList)
    '[data-test="JobDescription"]',
    '[data-component="JobDescription"]',
    '[class*="styles_jobDescription"]',
    '[class*="styles_description"]',
    // Workday / generic ATS
    '[data-automation-id="jobPostingDescription"]',
    // Generic
    '[class*="job-description"]',
    '[class*="jobDescription"]',
    '[class*="description__text"]',
    "article",
  ];

  const TITLE_SELECTORS = [
    // Wellfound
    '[data-test="JobListingHeader"] h1',
    '[class*="styles_header"] h1',
    '[class*="styles_title"] h1',
    '[class*="styles_jobTitle"]',
    // LinkedIn
    ".job-details-jobs-unified-top-card__job-title",
    ".jobs-unified-top-card__job-title",
    ".topcard__title",
    "h1.jobsearch-JobInfoHeader-title",
    '[data-automation-id="jobPostingHeader"]',
    ".posting-headline h2",
    "h1",
  ];

  const COMPANY_SELECTORS = [
    // Wellfound
    '[data-test="StartupHeader"] a',
    '[class*="styles_startupName"]',
    '[class*="styles_company"] a',
    '[class*="styles_companyName"]',
    // LinkedIn
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name",
    ".topcard__org-name-link",
    '[data-company-name]',
    ".jobsearch-CompanyInfoContainer a",
    ".posting-headline + div a",
    '[class*="company-name"]',
  ];

  // Fallback: pick the largest visible text block that looks like a JD.
  function largestTextBlock() {
    const candidates = Array.from(
      document.querySelectorAll(
        "article, section, main, div[class*='desc'], div[class*='content'], div"
      )
    );
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      // Skip page chrome — global nav, headers, sidebars, footers.
      if (el.closest("nav, header, footer, aside, [role='navigation'], [role='banner']")) continue;
      const t = stripBoilerplate(el.innerText || "");
      if (t.length < 200) continue;
      // Heuristic: JD text usually contains responsibility/requirement words.
      const jdish = /responsibilit|requirement|qualificat|experience|skills|role|about the job|what you|you will|we are looking/i.test(
        t
      );
      const score = t.length * (jdish ? 1.5 : 1);
      if (score > bestLen) {
        best = t;
        bestLen = score;
      }
    }
    return best || "";
  }

  function scrapeJD() {
    let jd = firstMatch(JD_SELECTORS);
    if (!jd || jd.length < 120) {
      const fallback = largestTextBlock();
      if (fallback.length > jd.length) jd = fallback;
    }
    jd = stripBoilerplate(jd).slice(0, 20000);

    const title = clean(firstMatch(TITLE_SELECTORS) || document.title.split("|")[0]).slice(0, 200);
    const company = clean(firstMatch(COMPANY_SELECTORS)).slice(0, 160);

    return {
      ok: jd.length >= 80,
      jd,
      title,
      company,
      url: location.href,
      pageTitle: document.title,
      chars: jd.length,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "scrapeJD") {
      try {
        sendResponse(scrapeJD());
      } catch (e) {
        sendResponse({ ok: false, error: e.message, url: location.href });
      }
    }
    return true;
  });
})();
