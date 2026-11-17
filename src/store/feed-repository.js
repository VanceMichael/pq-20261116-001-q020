import { normalizeLinkRules } from "../feed/link-rules.js";

export class FeedRepository {
  constructor(database) {
    this.database = database;
    this.insertFeed = database.prepare(`INSERT INTO feeds
      (feed_id, base_url, allowed_hosts_json, minimum_items, missing_threshold, link_rules_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET base_url=excluded.base_url,
      allowed_hosts_json=excluded.allowed_hosts_json, minimum_items=excluded.minimum_items,
      missing_threshold=excluded.missing_threshold,
      link_rules_json=COALESCE(excluded.link_rules_json, feeds.link_rules_json),
      updated_at=excluded.updated_at`);
    this.getFeed = database.prepare("SELECT * FROM feeds WHERE feed_id = ?");
    this.listFeeds = database.prepare("SELECT * FROM feeds ORDER BY feed_id");
    this.updateSuccess = database.prepare(`UPDATE feeds SET last_accepted_at=?, last_item_count=?, updated_at=?
      WHERE feed_id=?`);
    this.updateLinkRules = database.prepare(`UPDATE feeds SET link_rules_json=?, updated_at=? WHERE feed_id=?`);
  }

  register({ feedId, baseUrl, allowedHosts = [], minimumItems = 3, missingThreshold = 3, linkRules = undefined }, now) {
    validateFeedId(feedId);
    const base = new URL(baseUrl);
    if (!new Set(["http:", "https:"]).has(base.protocol)) throw new TypeError("feed base URL must use HTTP or HTTPS");
    if (base.username || base.password) throw new TypeError("feed base URL cannot contain credentials");
    if (!Number.isInteger(minimumItems) || minimumItems < 1 || minimumItems > 10_000) {
      throw new RangeError("minimumItems must be between 1 and 10000");
    }
    if (!Number.isInteger(missingThreshold) || missingThreshold < 2 || missingThreshold > 20) {
      throw new RangeError("missingThreshold must be between 2 and 20");
    }
    const hosts = [...new Set(allowedHosts.map((host) => String(host).toLowerCase()))];
    if (hosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) {
      throw new TypeError("allowedHosts must contain DNS host names");
    }
    if (!hosts.some((host) => base.hostname === host || base.hostname.endsWith(`.${host}`))) {
      throw new TypeError("feed base host must be included in allowedHosts");
    }
    const rulesJson = linkRules === undefined ? null : JSON.stringify(normalizeLinkRules(linkRules));
    this.insertFeed.run(feedId, base.href, JSON.stringify(hosts), minimumItems, missingThreshold, rulesJson, now, now);
    return this.get(feedId);
  }

  get(feedId) {
    const row = this.getFeed.get(feedId);
    return row ? mapFeed(row) : null;
  }

  all() {
    return this.listFeeds.all().map(mapFeed);
  }

  markAccepted(feedId, capturedAt, itemCount) {
    this.updateSuccess.run(capturedAt, itemCount, capturedAt, feedId);
  }

  saveLinkRules(feedId, rules, now) {
    const normalized = normalizeLinkRules(rules);
    this.updateLinkRules.run(JSON.stringify(normalized), now, feedId);
    return normalized;
  }
}

export function validateFeedId(feedId) {
  if (typeof feedId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(feedId)) {
    throw new TypeError("feedId must be 1 to 64 safe letters, digits, dots, underscores or hyphens");
  }
}

function mapFeed(row) {
  return {
    feedId: row.feed_id,
    baseUrl: row.base_url,
    allowedHosts: JSON.parse(row.allowed_hosts_json),
    minimumItems: row.minimum_items,
    missingThreshold: row.missing_threshold,
    lastAcceptedAt: row.last_accepted_at,
    lastItemCount: row.last_item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkRules: row.link_rules_json ? JSON.parse(row.link_rules_json) : { enabled: false, canonicalKey: "item", aliasKeys: ["item_id"] }
  };
}
