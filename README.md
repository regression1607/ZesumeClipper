# Zesume Clipper

A Manifest V3 browser extension companion for **Zesume.ai**. Clip the job
description from any job posting and **tailor one of your Zesume resumes to it in
one click** — the tailored resume opens straight in the Zesume editor.

Built from the scraping + background-orchestration patterns proven in the
`JobPilotAssist` prototype, and styled to match Zesume.ai's light LinkedIn-blue
theme.

## What it does

1. Reads the job description, title, and company from the current tab
   (LinkedIn, Indeed, Greenhouse, Lever, Workday, and most career pages).
2. Uses your existing Zesume.ai login (session cookies) — **no API keys stored**.
3. Lists your resumes, lets you pick one, and calls Zesume's
   `POST /api/ai/tailor` with the clipped JD.
4. Opens the tailored resume in the Zesume editor.

If you're not signed in, it can still **copy the JD** and open Zesume so you can
paste it into a new resume.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `ZesumeClipper` folder.
3. (Optional) Open `icons/generate-icons.html`, download the three PNGs into
   `icons/`, and add an `"icons"` block to `manifest.json`.
4. Open the extension **Options** and set your **Zesume app URL**
   (`https://zesume.ai`, or your local `http://localhost:5173` for dev).

## Using it

1. Open a job posting.
2. Click the Zesume Clipper toolbar icon.
3. Confirm the clipped job, choose a resume, and click **Tailor my resume to this job**.

## Files

```
manifest.json
lib/config.js                 shared app URL + endpoint paths (mirrors Zesume api.config.js)
content-scripts/jd-scraper.js scrape JD / title / company from the page
background/background.js       auth check, list resumes, tailor, open editor
popup/                        popup.html / popup.css / popup.js (Zesume-styled UI)
options/                      options.html / options.css / options.js (set app URL)
icons/generate-icons.html     icon generator (blue “Z” mark)
```

## Notes

- **Auth**: authenticated requests go directly to your Zesume origin with
  `credentials: "include"`. If your session cookie is `SameSite=Lax/Strict`, the
  browser may not send it on the extension's cross-site request — in that case
  the popup shows "Not signed in" and you can use the **Copy JD → Open Zesume**
  fallback. For seamless direct tailoring, the Zesume auth cookie should be
  `SameSite=None; Secure` (or the extension origin allow-listed by the backend).
- **Endpoints** are kept in sync with `Zesume-frontend/src/config/api.config.js`
  (`/api/auth/me`, `/api/resumes`, `/api/ai/tailor`). If those change, update
  `lib/config.js`.
- No third-party servers: the extension only talks to your configured Zesume app.
