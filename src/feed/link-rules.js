// Per-feed link parameter rules. The global tracking parameter filter in
// normalize.js always applies; the rules below only change article identity
// parameters for feeds that explicitly enable them.

export const DEFAULT_CANONICAL_KEY = "item";

export function normalizeLinkRules(input = {}) {
  const rules = input ?? {};
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new TypeError("linkRules must be an object");
  }
  const enabled = rules.enabled === true;
  const canonicalKey = normalizeKey(rules.canonicalKey ?? DEFAULT_CANONICAL_KEY, "canonicalKey");
  const aliasKeys = normalizeAliasKeys(rules.aliasKeys ?? ["item_id"], canonicalKey);
  return { enabled, canonicalKey, aliasKeys };
}

function normalizeKey(value, field) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_*-]{0,63}$/i.test(value)) {
    throw new TypeError(`${field} must be 1 to 64 query key characters`);
  }
  return value;
}

function normalizeAliasKeys(value, canonicalKey) {
  if (!Array.isArray(value)) throw new TypeError("aliasKeys must be an array of query keys");
  const aliases = [];
  for (const entry of value) {
    const key = normalizeKey(entry, "aliasKeys entry");
    if (key.toLowerCase() === canonicalKey.toLowerCase()) {
      throw new TypeError("aliasKeys must not contain the canonical key");
    }
    if (!aliases.some((existing) => existing.toLowerCase() === key.toLowerCase())) aliases.push(key);
  }
  return aliases;
}

// Applies the enabled parameter rules to an already-parsed URL in place.
// Throws TypeError when the same business number is expressed with different
// values in one URL so that no side can be silently chosen.
export function applyLinkRules(url, rules) {
  const normalized = normalizeLinkRules(rules);
  if (!normalized.enabled) return { changed: false };
  const params = url.searchParams;
  const lowerAliases = new Set(normalized.aliasKeys.map((key) => key.toLowerCase()));
  const lowerCanonical = normalized.canonicalKey.toLowerCase();
  const identityValues = new Set();
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (!lowerAliases.has(lower) && lower !== lowerCanonical) continue;
    for (const value of params.getAll(key)) identityValues.add(value);
  }
  if (identityValues.size > 1) {
    throw new TypeError(`link rule conflict: competing business numbers ${[...identityValues].join(" vs ")}`);
  }
  let changed = false;
  const canonicalValue = [...identityValues][0];
  for (const key of [...params.keys()]) {
    if (lowerAliases.has(key.toLowerCase())) {
      params.delete(key);
      changed = true;
    }
  }
  if (changed && canonicalValue !== undefined && !params.has(normalized.canonicalKey)) {
    params.append(normalized.canonicalKey, canonicalValue);
  }
  return { changed };
}

// Pure grouping used by migration previews: maps every stored URL to the URL
// the rules would produce, and groups sources that collapse onto one key.
export function previewUrlGroups(urls, rules) {
  const normalized = normalizeLinkRules(rules);
  const groups = new Map();
  const conflicts = [];
  for (const sourceUrl of urls) {
    let url;
    try {
      url = new URL(sourceUrl);
    } catch {
      conflicts.push({ sourceUrl, reason: "invalid_url" });
      continue;
    }
    let targetUrl;
    try {
      applyLinkRules(url, normalized);
      url.searchParams.sort();
      targetUrl = url.href;
    } catch (error) {
      conflicts.push({ sourceUrl, reason: error.message });
      continue;
    }
    if (!groups.has(targetUrl)) groups.set(targetUrl, new Set());
    groups.get(targetUrl).add(sourceUrl);
  }
  const renames = [];
  const collisions = [];
  let unchanged = 0;
  for (const [targetUrl, sourceSet] of groups) {
    const sourceUrls = [...sourceSet].sort();
    if (sourceUrls.length > 1) {
      collisions.push({ targetUrl, sourceUrls });
    } else if (sourceUrls[0] === targetUrl) {
      unchanged += 1;
    } else {
      renames.push({ targetUrl, sourceUrls });
    }
  }
  const order = (a, b) => (a.targetUrl < b.targetUrl ? -1 : a.targetUrl > b.targetUrl ? 1 : 0);
  return {
    rules: normalized,
    renames: renames.sort(order),
    collisions: collisions.sort(order),
    unchanged,
    conflicts
  };
}
