import { applyLinkRules } from "./link-rules.js";

const TRACKING_KEYS = new Set(["from", "source", "spm", "share", "ref", "utm_source", "utm_medium", "utm_campaign"]);

export function canonicalizeUrl(input, baseUrl, allowedHosts = [], linkRules = null) {
  let url;
  try {
    url = new URL(input, baseUrl);
  } catch {
    throw new TypeError(`invalid article URL: ${input}`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new TypeError("article URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new TypeError("article URL cannot contain credentials");
  if (allowedHosts.length && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new TypeError(`article host is not allowed: ${url.hostname}`);
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  if (linkRules) applyLinkRules(url, linkRules);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+/g, "/");
  return url.href;
}

export function cleanTitle(input) {
  if (typeof input !== "string") throw new TypeError("article title must be text");
  const title = input.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (title.length < 2 || title.length > 500) throw new RangeError("article title must contain 2 to 500 characters");
  return title;
}

export function normalizePublishedAt(input) {
  if (!input) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function normalizeCandidates(candidates, { baseUrl, allowedHosts = [], linkRules = null }) {
  const byUrl = new Map();
  const rejected = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      // The observed URL applies the global tracking rules only and never the
      // per-feed identity rewrite, so the link literally seen at capture time
      // stays locatable even after item_id is unified to item.
      const observedUrl = canonicalizeUrl(candidate.href, baseUrl, allowedHosts);
      const canonicalUrl = linkRules
        ? canonicalizeUrl(candidate.href, baseUrl, allowedHosts, linkRules)
        : observedUrl;
      const title = cleanTitle(candidate.title);
      const publishedAt = normalizePublishedAt(candidate.publishedAt);
      const current = byUrl.get(canonicalUrl);
      if (!current) {
        byUrl.set(canonicalUrl, { canonicalUrl, observedUrl, title, publishedAt, sourceIndex: index });
      } else {
        if (publishedAt && (!current.publishedAt || publishedAt < current.publishedAt)) {
          current.publishedAt = publishedAt;
        }
      }
    } catch (error) {
      rejected.push({ index, reason: error.message });
    }
  }
  return { records: [...byUrl.values()], rejected, duplicateCount: candidates.length - byUrl.size - rejected.length };
}
