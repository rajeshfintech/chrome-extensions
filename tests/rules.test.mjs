// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { urlParts, ruleScore, matchGroup, matchPattern, ruleKey, usesTitles }
  from '../tab-auto-grouper/extension/rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const shared of ['rules.js', 'self-update.js']) {
  test(`both extensions ship the same ${shared}`, () => {
    const a = readFileSync(join(root, 'tab-auto-grouper/extension', shared), 'utf8');
    const b = readFileSync(join(root, 'auto-tab-closer/extension', shared), 'utf8');
    assert.equal(a, b, `copy tab-auto-grouper/extension/${shared} over auto-tab-closer/extension/${shared}`);
  });
}

test('isStaleWorkerReply spots an old or missing background worker', async () => {
  const { isStaleWorkerReply } = await import('../tab-auto-grouper/extension/self-update.js');
  // old 1.1.x grouper get_status reply: no `groups`
  assert.ok(isStaleWorkerReply({ configLoadedAt: 1, groupCount: 5, groupNames: ['a'] }, 'groups'));
  // unknown message type on an old worker
  assert.ok(isStaleWorkerReply({ success: false, error: 'The message port closed before a response was received.' }, 'success'));
  assert.ok(isStaleWorkerReply({ ok: false, error: 'Could not establish connection. Receiving end does not exist.' }, 'ok'));
  assert.ok(isStaleWorkerReply(undefined, 'ok'));
  // current worker replies, including its own error path
  assert.ok(!isStaleWorkerReply({ groups: [], configLoadedAt: 1 }, 'groups'));
  assert.ok(!isStaleWorkerReply({ ok: true, pending: {} }, 'ok'));
  assert.ok(!isStaleWorkerReply({ success: false, error: 'Pick a group' }, 'success'));
});

test('urlParts strips www and trailing slashes', () => {
  const p = urlParts('https://WWW.Example.com/Docs/');
  assert.equal(p.host, 'example.com');
  assert.equal(p.fullPath, 'example.com/docs');
  assert.equal(urlParts('not a url'), null);
});

test('domain rule matches host and subdomains only', () => {
  const p = urlParts('https://api.github.com/repos');
  assert.ok(ruleScore({ domain: 'github.com' }, p) > 0);
  assert.ok(ruleScore({ domain: 'www.github.com' }, p) > 0);
  assert.equal(ruleScore({ domain: 'hub.com' }, p), 0);
  assert.equal(ruleScore({ domain: 'github.com' }, urlParts('https://notgithub.com/')), 0);
});

test('path rule matches host + path prefix on segment boundaries', () => {
  assert.ok(ruleScore({ path: 'docs.google.com/document' }, urlParts('https://docs.google.com/document/d/1/edit')) > 0);
  assert.ok(ruleScore({ path: 'docs.google.com/document' }, urlParts('https://docs.google.com/document')) > 0);
  assert.ok(ruleScore({ path: 'docs.google.com/document/' }, urlParts('https://docs.google.com/document?x=1')) > 0);
  assert.equal(ruleScore({ path: 'docs.google.com/document' }, urlParts('https://docs.google.com/documents')), 0);
  assert.ok(ruleScore({ path: 'https://github.com/login' }, urlParts('https://github.com/login')) > 0);
});

test('match rule is a raw case-insensitive substring', () => {
  const p = urlParts('https://signin.aws.amazon.com/oauth?x=1');
  assert.ok(ruleScore({ match: 'SIGNIN.AWS.AMAZON.COM' }, p) > 0);
  assert.ok(ruleScore({ match: 'oauth?x' }, p) > 0);
  assert.equal(ruleScore({ match: 'github' }, p), 0);
});

test('pattern rule is a regex on the full URL; invalid regexes never match', () => {
  const p = urlParts('https://acme.okta.com/login/login.htm');
  assert.ok(ruleScore({ pattern: '^https://[^/]+\\.okta\\.com/login' }, p) > 0);
  assert.equal(ruleScore({ pattern: '^https://okta\\.com/' }, p), 0);
  assert.equal(ruleScore({ pattern: '[' }, p), 0);
});

test('title rule needs a title and is case-insensitive', () => {
  const p = urlParts('https://example.com/');
  assert.ok(ruleScore({ title: '[jira]' }, p, '[JIRA] Fix login') > 0);
  assert.equal(ruleScore({ title: '[jira]' }, p, 'Other'), 0);
  assert.equal(ruleScore({ title: '[jira]' }, p, undefined), 0);
  assert.ok(usesTitles([{ domain: 'a.com' }, { title: 'x' }]));
  assert.ok(!usesTitles([{ domain: 'a.com' }]));
});

const groups = [
  { name: 'Google', rules: [{ domain: 'google.com' }] },
  { name: 'AI', rules: [{ domain: 'gemini.google.com' }, { domain: 'claude.ai' }] },
  { name: 'Docs', rules: [{ path: 'docs.google.com/document' }] },
];

test('matchGroup: longest matching rule wins regardless of group order', () => {
  assert.equal(matchGroup('https://gemini.google.com/app', '', groups, []).name, 'AI');
  assert.equal(matchGroup('https://mail.google.com/', '', groups, []).name, 'Google');
  assert.equal(matchGroup('https://docs.google.com/document/d/1', '', groups, []).name, 'Docs');
  assert.equal(matchGroup('https://docs.google.com/spreadsheets/d/1', '', groups, []).name, 'Google');
  assert.equal(matchGroup('https://example.com/', '', groups, []), null);
});

test('matchGroup: ties keep config order, priority overrides length', () => {
  const tie = [
    { name: 'First', rules: [{ domain: 'example.com' }] },
    { name: 'Second', rules: [{ domain: 'example.com' }] },
  ];
  assert.equal(matchGroup('https://example.com/', '', tie, []).name, 'First');
  const prio = [
    { name: 'Catch-all', priority: 5, rules: [{ domain: 'google.com' }] },
    { name: 'AI', rules: [{ domain: 'gemini.google.com' }] },
  ];
  assert.equal(matchGroup('https://gemini.google.com/', '', prio, []).name, 'Catch-all');
});

test('matchGroup: excludes win outright', () => {
  assert.equal(matchGroup('https://claude.ai/chat', '', groups, [{ domain: 'claude.ai' }]), null);
  assert.equal(matchGroup('https://claude.ai/chat', '', groups, [{ domain: 'other.ai' }]).name, 'AI');
});

test('matchPattern returns the most specific pattern entry', () => {
  const patterns = [
    { name: 'Atlassian', path: 'atlassian.com/login' },
    { name: 'Atlassian ID', path: 'id.atlassian.com/login', idle_minutes: 2 },
    { name: 'Legacy', match: 'github.com/login' },
  ];
  assert.equal(matchPattern('https://id.atlassian.com/login?x', '', patterns).name, 'Atlassian ID');
  assert.equal(matchPattern('https://github.com/login', '', patterns).name, 'Legacy');
  assert.equal(matchPattern('https://github.com/', '', patterns), null);
  assert.equal(matchPattern('chrome://extensions/', '', patterns), null);
});

test('ruleKey gives a stable identity per rule', () => {
  assert.equal(ruleKey({ domain: ' GitHub.com ' }), 'domain:github.com');
  assert.equal(ruleKey({ name: 'x', path: 'a/b' }), 'path:a/b');
  assert.equal(ruleKey({ name: 'x' }), '');
});
