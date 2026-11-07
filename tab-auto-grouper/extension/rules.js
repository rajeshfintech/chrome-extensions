// Shared URL/title rule matching for Tab Auto Grouper and Auto Tab Closer.
// Both extensions ship an identical copy of this file; tests/rules.test.mjs
// fails if the two copies drift apart.
//
// Rule shapes (one key per rule):
//   { domain: "github.com" }              host or any subdomain
//   { path: "docs.google.com/document" }  host + path prefix
//   { match: "github.com/login" }         raw substring anywhere in the URL
//   { pattern: "^https://.*\\.okta\\.com/" } case-insensitive regex on the full URL
//   { title: "[JIRA]" }                    case-insensitive substring of the tab title
//
// A matching rule returns a score equal to the length of the matched rule
// text, so the longest (most specific) rule wins when several match.

const regexCache = new Map();

function compile(pattern) {
  const key = String(pattern);
  if (!regexCache.has(key)) {
    try { regexCache.set(key, new RegExp(key, 'i')); }
    catch { regexCache.set(key, null); }
  }
  return regexCache.get(key);
}

function stripWww(s) { return s.replace(/^www\./, ''); }

export function urlParts(url) {
  try {
    const u = new URL(url);
    const host = stripWww(u.hostname.toLowerCase());
    const fullPath = (host + u.pathname.toLowerCase()).replace(/\/+$/, '');
    return { host, fullPath, href: u.href.toLowerCase() };
  } catch { return null; }
}

export function normaliseDomain(d) {
  return stripWww(String(d).trim().toLowerCase()).replace(/^\./, '').replace(/\/.*$/, '');
}

export function normalisePath(p) {
  return stripWww(String(p).trim().toLowerCase().replace(/^https?:\/\//, '')).replace(/\/+$/, '');
}

// Score > 0 when the rule matches; 0 otherwise.
export function ruleScore(rule, parts, title) {
  if (!rule || !parts) return 0;
  if (rule.domain) {
    const d = normaliseDomain(rule.domain);
    if (d && (parts.host === d || parts.host.endsWith('.' + d))) return d.length;
  }
  if (rule.path) {
    const p = normalisePath(rule.path);
    if (p && (parts.fullPath === p || parts.fullPath.startsWith(p + '/'))) return p.length;
  }
  if (rule.match) {
    const m = String(rule.match).trim().toLowerCase();
    if (m && parts.href.includes(m)) return m.length;
  }
  if (rule.pattern) {
    const re = compile(rule.pattern);
    if (re && re.test(parts.href)) return String(rule.pattern).length;
  }
  if (rule.title && title) {
    const t = String(rule.title).trim().toLowerCase();
    if (t && String(title).toLowerCase().includes(t)) return t.length;
  }
  return 0;
}

// Best-scoring rule in a list, or null.
export function bestRule(rules, parts, title) {
  let best = null;
  let bestScore = 0;
  for (const rule of (rules || [])) {
    const score = ruleScore(rule, parts, title);
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  return best ? { rule: best, score: bestScore } : null;
}

export function matchesAny(rules, parts, title) {
  return bestRule(rules, parts, title) !== null;
}

// Tab Auto Grouper: pick the group for a URL/title.
// Excludes win outright. Then the group with the highest `priority` wins;
// among equal priority the longest matching rule wins; ties keep config order.
export function matchGroup(url, title, groups, excludes) {
  const parts = urlParts(url);
  if (!parts) return null;
  if (matchesAny(excludes, parts, title)) return null;

  let best = null;
  let bestScore = 0;
  let bestPriority = -Infinity;
  for (const group of (groups || [])) {
    const hit = bestRule(group.rules, parts, title);
    if (!hit) continue;
    const priority = Number(group.priority) || 0;
    if (priority > bestPriority || (priority === bestPriority && hit.score > bestScore)) {
      best = group;
      bestScore = hit.score;
      bestPriority = priority;
    }
  }
  return best;
}

// Auto Tab Closer: pick the pattern entry for a URL/title (patterns are rules
// carrying extra keys such as `name` and `idle_minutes`).
export function matchPattern(url, title, patterns) {
  const parts = urlParts(url);
  if (!parts) return null;
  const hit = bestRule(patterns, parts, title);
  return hit ? hit.rule : null;
}

// True when any rule in the list needs the tab title to evaluate.
export function usesTitles(rules) {
  return (rules || []).some(r => r && r.title);
}

// Stable identity for a rule, used for de-duplication in the popups.
export function ruleKey(rule) {
  for (const k of ['domain', 'path', 'match', 'pattern', 'title']) {
    if (rule && rule[k]) return `${k}:${String(rule[k]).trim().toLowerCase()}`;
  }
  return '';
}
