# Chrome Web Store Listing — Zesume Clipper

> Last Updated: 2026-09-13

## Store Listing

**Extension Name** [REQUIRED]
Zesume Clipper

**Short Description** [REQUIRED]
Clip any job description and tailor your Zesume.ai resume to it in one click.

**Detailed Description** [REQUIRED]
Zesume Clipper is your all-in-one career assistant that clips job descriptions from any webpage, tailors your resume to beat ATS filters, and auto-applies to startup roles on autopilot.

KEY FEATURES:
- One-Click Job Description Clipper: Automatically extract role titles, company names, and full requirements from job postings across the web.
- Instant AI Resume Tailoring: Match your skills and achievements to specific job description keywords in seconds directly from your browser.
- Wellfound & LinkedIn Auto-Apply: Automate job applications on Wellfound (AngelList) and LinkedIn (Easy Apply) with intelligent screening question responses. Support for Indeed and Naukri is coming next!
- ATS Match Scoring: View live match scores and keyword suggestions before submitting your application.
- Seamless Zesume Integration: Sync directly with your Zesume.in account, existing resumes, and credit balance without needing separate API keys.

HOW TO USE:
1. Sign in to your account at zesume.in.
2. Open any job posting on Wellfound, LinkedIn, Indeed, or any company careers page.
3. Click the Zesume Clipper icon in your Chrome toolbar to open the side panel.
4. Click "Tailor my resume to this job" to generate an ATS-optimized CV, or configure Auto-Apply to apply on autopilot.
5. Review all pre-filled fields and complete any unhandled or unique questions manually before submitting.

DISCLAIMER & TERMS:
Zesume Clipper is an independent assistive tool and is NOT affiliated with, sponsored by, or endorsed by LinkedIn, Wellfound, Indeed, or Naukri. Users must review all job application answers before submission. Full terms: https://www.zesume.in/terms.

PRIVACY & SECURITY:
Your personal information and resumes remain private. Zesume Clipper communicates securely over HTTPS with your authenticated Zesume account session. We do not sell your personal data or browsing history to third parties.

SUPPORT & FEEDBACK:
Need help, found a layout bug, or have suggestions? Contact our team with screenshots and logs at ekanshrajput1607@gmail.com or visit https://www.zesume.in.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Tailors your resume to job postings from any webpage and automates job applications on Wellfound and LinkedIn in one click.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename / Location |
|-------|-----------|--------|---------------------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Small Icon | 16×16 PNG | ✅ Ready | `icons/icon16.png` |
| Medium Icon | 48×48 PNG | ✅ Ready | `icons/icon48.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Upload to Dashboard | Screenshot of Side Panel clipping a job description |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Upload to Dashboard | Screenshot of Tailoring options and resume selector |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Upload to Dashboard | Screenshot of Auto-Apply running on Wellfound |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Optional | Promo graphic with Zesume logo |
| Marquee Promo Tile | 1400×560 | ⬜ Optional | Featured banner |

---

## Permissions Justification

Every permission in `manifest.json` requires an explanation in the Chrome Developer Dashboard:

| Permission | Type | Justification to paste in Chrome Developer Dashboard |
|------------|------|------------------------------------------------------|
| `storage` | permissions | Used to save user preferences, auto-apply profile details, and cached auth state locally on the user's device. |
| `activeTab` | permissions | Used to read the job title, company, and job description text from the active tab when the user initiates a clip or scan action. |
| `scripting` | permissions | Used to inject the job description extractor and auto-apply form helpers into job posting pages. |
| `tabs` | permissions | Used to detect the active tab's URL and title for job clippings and to open tailored resumes and user dashboards in Zesume. |
| `sidePanel` | permissions | Used to host the primary extension interface inside Chrome's native side panel for side-by-side job browsing. |
| `<all_urls>` | host_permissions | The extension needs to clip job descriptions from any job portal, company career site, or applicant tracking system (e.g. Wellfound, Greenhouse, Lever, Workday) that the user visits. |

---

## Privacy & Data Use

### Data Collection Declarations (Chrome Web Store Form)

**Does the extension collect user data?** Yes

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info (Name, Email, Phone) | Yes | Yes (to api.zesume.in) | Used to answer job application screening fields when the user runs Auto-Apply. | No |
| Authentication info (Session cookies) | Yes | Yes (to api.zesume.in) | Used to authenticate requests with the user's logged-in Zesume account. | No |
| Website content (Job descriptions) | Yes | Yes (to api.zesume.in) | Used to analyze job requirements and tailor the user's selected resume with AI. | No |
| Web history | No | No | Not collected. | No |
| Location | Yes (City/Region in profile) | Yes (to api.zesume.in) | Used for job search location filtering and job application forms. | No |
| Financial info | No | No | Not collected. Payments are handled separately on the web. | No |
| Health info | No | No | Not collected. | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
`https://www.zesume.in/privacy`

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name** [REQUIRED]
Zesume.in

**Contact Email** [REQUIRED]
ekanshrajput1607@gmail.com

**Support URL / Email** [RECOMMENDED]
ekanshrajput1607@gmail.com

**Homepage URL** [RECOMMENDED]
https://www.zesume.in

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-09-14 | Initial store release with JD clipping, AI resume tailoring, and Wellfound & LinkedIn auto-apply. | Ready to Submit |

