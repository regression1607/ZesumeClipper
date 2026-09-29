export function approvedJobUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
      || !['linkedin.com', 'www.linkedin.com', 'wellfound.com', 'www.wellfound.com', 'angel.co', 'www.angel.co'].includes(url.hostname)) {
    throw new Error('Applications are restricted to HTTPS LinkedIn and Wellfound pages.');
  }
  return url;
}

export function validateFills(fills, fields) {
  if (!Array.isArray(fills) || fills.length > 80) throw new Error('Invalid field mapping');
  const allowed = new Map(fields.map(field => [field.selector, field]));
  const seen = new Set();
  return fills.map(fill => {
    const field = allowed.get(fill?.selector);
    if (!field || seen.has(fill.selector) || !['string', 'boolean'].includes(typeof fill.value)
        || String(fill.value).length > 4000) throw new Error('AI returned an unexpected field or answer');
    if (field.options?.length && !field.options.includes(String(fill.value))) throw new Error('Invalid field option');
    seen.add(fill.selector);
    return { selector: fill.selector, value: fill.value };
  });
}

export async function reviewApplication({ job, tab, settings, send, ask, generate, status, cancelled }) {
  const expected = approvedJobUrl(job.url);
  const check = async () => {
    if (cancelled()) throw new Error('Stopped by user');
    const current = await chrome.tabs.get(tab.id);
    const actual = approvedJobUrl(current.url);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw new Error('Page changed; restart review on the intended job.');
  };
  await check();
  await send(tab.id, { type: expected.hostname.endsWith('linkedin.com') ? 'linkedinOpenEasyApply' : 'wellfoundOpenApply' });
  for (let step = 0; step < 20; step++) {
    await check();
    const snapshot = await send(tab.id, { type: 'secureScrapeForm' });
    if (!snapshot?.ok) throw new Error(snapshot?.error || 'Open the application form and try again.');
    const fields = snapshot.fields;
    if (fields.length) {
      const suggested = validateFills(await generate(fields, { ...settings.profile, jobContext: { company: job.company, role: job.title } }), fields);
      await check();
      const questions = fields.map(field => ({ ...field, suggested: suggested.find(fill => fill.selector === field.selector)?.value ?? '' }));
      const result = await ask(questions, { company: job.company, role: job.title, step: step + 1, stage: 'Review before sharing answers' });
      await check();
      if (result.skip) throw new Error('Skipped by user');
      const fills = validateFills(Object.entries(result.answers || {}).filter(([, value]) => value !== '').map(([selector, value]) => ({ selector, value })), fields);
      if (fields.some(field => field.required && !fills.some(fill => fill.selector === field.selector))) throw new Error('Required answers are missing. Nothing was filled.');
      const response = await send(tab.id, { type: 'fillForm', snapshotId: snapshot.id, expectedUrl: snapshot.url, fills });
      if (!response?.ok || response.results?.some(result => !result.ok)) throw new Error('Form changed or an answer could not be filled. Review it in the tab.');
    }
    await check();
    status('Answers filled. Review the job page and click Next or Submit yourself.');
    const next = await ask([
      { selector: 'review-next', label: 'After reviewing the application page', type: 'select', options: ['Review the next step', 'Finished this application'] },
    ], { company: job.company, role: job.title, step: step + 1, stage: 'Final submission stays in the job page' });
    if (cancelled()) throw new Error('Stopped by user');
    if (next.skip || next.answers?.['review-next'] !== 'Review the next step') return;
  }
  throw new Error('Application step limit reached. Finish in the job page.');
}
