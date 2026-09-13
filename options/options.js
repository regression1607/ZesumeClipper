const $ = (id) => document.getElementById(id);

async function loadAi() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const p = settings.profile || {};
  $("name").value = p.name || "";
  $("email").value = p.email || "";
  $("phone").value = p.phone || "";
  $("location").value = p.location || "";
  $("currentRole").value = p.currentRole || "";
  $("experienceYears").value = p.experienceYears ?? "";
  $("linkedin").value = p.linkedin || "";
  $("github").value = p.github || "";
  $("workAuthorization").value = p.workAuthorization || "Yes";
  $("sponsorshipRequired").value = p.sponsorshipRequired || "No";
  $("noticePeriod").value = p.noticePeriod || "";
  $("expectedSalary").value = p.expectedSalary || "";
  $("links").value = p.links || "";
  $("resumeText").value = p.resumeText || "";
  $("coverLetterTemplate").value = p.coverLetterTemplate || "";
  $("batchSize").value = settings.batchSize ?? 5;
  $("rateLimitSeconds").value = settings.rateLimitSeconds ?? 25;
}

async function saveAi() {
  const { settings: prev = {} } = await chrome.storage.local.get("settings");
  const settings = {
    ...prev,
    // AI runs through Zesume's backend — no API key needed.
    provider: "zesume",
    profile: {
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      phone: $("phone").value.trim(),
      location: $("location").value.trim(),
      currentRole: $("currentRole").value.trim(),
      experienceYears: $("experienceYears").value ? parseInt($("experienceYears").value, 10) : "",
      linkedin: $("linkedin").value.trim(),
      github: $("github").value.trim(),
      workAuthorization: $("workAuthorization").value,
      sponsorshipRequired: $("sponsorshipRequired").value,
      noticePeriod: $("noticePeriod").value.trim(),
      expectedSalary: $("expectedSalary").value.trim(),
      links: $("links").value.trim(),
      resumeText: $("resumeText").value.trim(),
      coverLetterTemplate: $("coverLetterTemplate").value.trim(),
    },
    batchSize: parseInt($("batchSize").value, 10) || 5,
    rateLimitSeconds: parseInt($("rateLimitSeconds").value, 10) || 25,
  };
  await chrome.storage.local.set({ settings });
  const note = $("saved-ai");
  note.textContent = "Saved successfully!";
  setTimeout(() => (note.textContent = ""), 2500);
}

$("save-ai").addEventListener("click", saveAi);

loadAi();
