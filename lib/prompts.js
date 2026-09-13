// Prompt builders for JobPilot Assist. STRICT JSON output only.

export function buildRankingPrompt(listings, criteria) {
  const system = [
    "You are a job-matching assistant.",
    "Given a list of job listings and a user's search criteria, decide which jobs the user should apply to.",
    "The user has ALREADY filtered these listings with their own job-board search, so lean strongly towards applying.",
    "If criteria keywords are empty or omitted, mark shouldApply=true for ALL listings.",
    "Otherwise, set shouldApply=true unless the job title is clearly for a completely different profession (e.g. nurse/driver when searching tech roles).",
    "Missing or empty company/description is NOT a reason to reject — judge mainly by the job title vs the criteria.",
    "You MUST return exactly one element for EVERY listing provided, preserving each listing's url verbatim.",
    "Return ONLY a JSON array. No markdown, no code fences, no preamble, no trailing text.",
    "Each element must be: {\"title\": string, \"company\": string, \"url\": string, \"shouldApply\": boolean, \"reason\": string}.",
    "`reason` must be very short (under 6 words)."
  ].join(" ");

  const user = JSON.stringify(
    {
      criteria,
      listings
    },
    null,
    2
  );

  return { system, user };
}

export function buildFieldMappingPrompt(formFields, userProfile) {
  const system = [
    "You are a form-filling assistant for job applications.",
    "You are given a list of form fields (each with a stable CSS selector, label, type, and possible options) and the user's profile / resume / cover letter template.",
    "Produce a value for EVERY field. Never leave a required field empty.",
    "Confidence rules:",
    "- \"high\": you can answer directly from the user's profile / resume / standard info (name, email, phone, location, links, work authorization, standard experience questions), OR it is a common screening question you can answer sensibly (see below).",
    "- \"low\": genuinely unusual free-text/essay prompts, or answers requiring info you truly cannot infer (e.g. a specific reference name).",
    "Common job-application screening questions — answer concretely and mark \"high\" so the application can proceed automatically:",
    "  - Years of experience with a skill/tool (e.g. \"How many years ... AWS?\"): answer with a realistic integer inferred from the resume; if not derivable, use a reasonable number like 2 or 3. Provide just the number for numeric fields.",
    "  - Eligibility yes/no questions (authorized to work, require sponsorship, completed a degree, willing to commute/relocate, comfortable with the location/work mode, background check, notice period ok): choose the option that keeps the candidate eligible and employable (usually the affirmative), unless the resume/profile clearly contradicts it.",
    "  - Salary expectation: give a reasonable market number if a value is required.",
    "For cover-letter style free-text fields, lightly personalize the user's coverLetterTemplate by substituting {company} and {role}.",
    "For select/radio fields, `value` MUST be exactly one of the provided options verbatim (match the option text exactly, e.g. \"Yes\").",
    "For checkboxes, `value` must be the boolean true or false.",
    "Return ONLY a JSON object of the form {\"fills\": [{\"selector\": string, \"value\": string|boolean, \"confidence\": \"high\"|\"low\"}]}.",
    "No markdown, no code fences, no preamble, no trailing text."
  ].join(" ");

  const safeProfile = {
    name: userProfile.name,
    email: userProfile.email,
    phone: userProfile.phone,
    location: userProfile.location,
    currentRole: userProfile.currentRole,
    experienceYears: userProfile.experienceYears,
    linkedin: userProfile.linkedin,
    github: userProfile.github,
    links: userProfile.links,
    workAuthorization: userProfile.workAuthorization,
    sponsorshipRequired: userProfile.sponsorshipRequired,
    noticePeriod: userProfile.noticePeriod,
    expectedSalary: userProfile.expectedSalary,
    resumeText: userProfile.resumeText,
    coverLetterTemplate: userProfile.coverLetterTemplate,
    jobContext: userProfile.jobContext // {company, role}
  };

  const user = JSON.stringify(
    {
      formFields,
      userProfile: safeProfile
    },
    null,
    2
  );

  return { system, user };
}
