import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { approvedJobUrl, validateFills, reviewApplication } from './application-security.js';

const fields = [{ selector: '#name', label: 'Name', type: 'text', required: true }];
const job = { url: 'https://www.linkedin.com/jobs/view/1', company: 'Fixture', title: 'Role' };

test('job origins require HTTPS and exact approved hostnames', () => {
  for (const value of ['http://www.linkedin.com/jobs/1', 'https://linkedin.com.evil.invalid/job', 'https://user@www.linkedin.com/job', 'https://other.invalid/job']) {
    assert.throws(() => approvedJobUrl(value));
  }
  assert.equal(approvedJobUrl(job.url).hostname, 'www.linkedin.com');
});

test('AI output cannot invent selectors, duplicate fills or arbitrary options', () => {
  assert.throws(() => validateFills([{ selector: '#other', value: 'secret' }], fields));
  assert.throws(() => validateFills([{ selector: '#name', value: {} }], fields));
  assert.throws(() => validateFills([{ selector: '#name', value: 'x' }, { selector: '#name', value: 'y' }], fields));
  assert.throws(() => validateFills([{ selector: '#choice', value: 'invented' }], [{ selector: '#choice', options: ['Yes', 'No'] }]));
});

test('no answer reaches the page before approval and submission remains manual', async () => {
  globalThis.chrome = { tabs: { get: async () => ({ url: job.url }) } };
  let approved = false;
  const commands = [];
  await reviewApplication({
    job, tab: { id: 1 }, settings: { profile: {} }, cancelled: () => false, status() {},
    generate: async () => [{ selector: '#name', value: 'Suggestion', confidence: 'low' }],
    send: async (_tab, message) => {
      commands.push(message);
      if (message.type === 'secureScrapeForm') return { ok: true, id: 'fixture', url: job.url, fields };
      if (message.type === 'fillForm') {
        assert.equal(approved, true);
        assert.equal(message.fills[0].value, 'Approved name');
        return { ok: true, results: [{ ok: true }] };
      }
      return { ok: true };
    },
    ask: async questions => {
      if (questions[0].selector === 'review-next') return { answers: { 'review-next': 'Finished this application' } };
      assert.equal(commands.some(message => message.type === 'fillForm'), false);
      approved = true;
      return { answers: { '#name': 'Approved name' } };
    },
  });
  assert.equal(commands.filter(message => message.type === 'fillForm').length, 1);
  assert.equal(commands.some(message => /submit|ClickPrimary|ClickSend/.test(message.type)), false);
});

test('Stop while awaiting approval prevents writes', async () => {
  globalThis.chrome = { tabs: { get: async () => ({ url: job.url }) } };
  let stopped = false;
  const commands = [];
  await assert.rejects(reviewApplication({
    job, tab: { id: 1 }, settings: { profile: {} }, cancelled: () => stopped, status() {},
    generate: async () => [{ selector: '#name', value: 'Suggestion' }],
    send: async (_tab, message) => {
      commands.push(message);
      return message.type === 'secureScrapeForm' ? { ok: true, id: 'fixture', url: job.url, fields } : { ok: true };
    },
    ask: async () => { stopped = true; return { answers: { '#name': 'Do not share' } }; },
  }), /Stopped/);
  assert.equal(commands.some(message => message.type === 'fillForm'), false);
});

test('navigation away from the selected job prevents application actions', async () => {
  globalThis.chrome = { tabs: { get: async () => ({ url: 'https://www.linkedin.com/settings' }) } };
  let sent = false;
  await assert.rejects(reviewApplication({ job, tab: { id: 1 }, settings: { profile: {} }, cancelled: () => false,
    send: async () => { sent = true; } }), /Page changed/);
  assert.equal(sent, false);
});

test('legacy submit messages cannot click page controls', () => {
  let listener;
  const context = vm.createContext({ window: {}, chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    document: { querySelector() { throw new Error('Page controls must not be queried'); } } });
  vm.runInContext(readFileSync(new URL('../content-scripts/apply-submitter.js', import.meta.url), 'utf8'), context);
  let result;
  listener({ type: 'submitForm' }, {}, value => { result = value; });
  assert.equal(result.confirmed, false);
  assert.equal(result.note, 'manual-submission-required');
});
