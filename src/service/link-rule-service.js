import { normalizeLinkRules, previewUrlGroups } from "../feed/link-rules.js";

export class LinkRuleService {
  constructor({ database, feeds, identities, articles, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.identities = identities;
    this.articles = articles;
    this.clock = clock;
  }

  requireFeed(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    return feed;
  }

  // Read-only projection of what activating the rules would do. No article,
  // capture or identity rows are mutated; only an audit event is appended.
  preview(feedId, overrideRules = null) {
    const feed = this.requireFeed(feedId);
    if (!feed) return null;
    const rules = normalizeLinkRules(overrideRules ?? feed.linkRules);
    const stored = this.identities.articlesFor(feedId);
    const groups = previewUrlGroups(stored.map((article) => article.canonicalUrl), rules);
    const byUrl = new Map(stored.map((article) => [article.canonicalUrl, article]));
    const summarize = (group) => ({
      targetUrl: group.targetUrl,
      sources: group.sourceUrls.map((url) => summarizeArticle(byUrl.get(url)))
    });
    const report = {
      feedId,
      rules,
      storedArticleCount: stored.length,
      renameCount: groups.renames.length,
      collisionCount: groups.collisions.length,
      conflictCount: groups.conflicts.length,
      renames: groups.renames.map(summarize),
      collisions: groups.collisions.map((group) => {
        const sources = group.sourceUrls.map((url) => summarizeArticle(byUrl.get(url)));
        const reviewStates = new Set(sources.map((source) => source.reviewState));
        return {
          targetUrl: group.targetUrl,
          reviewConflict: reviewStates.size > 1,
          reviewStates: [...reviewStates],
          sources
        };
      }),
      conflicts: groups.conflicts
    };
    this.identities.recordEvent(feedId, "preview", {
      rules, renameCount: report.renameCount, collisionCount: report.collisionCount,
      conflictCount: report.conflictCount
    }, this.clock().toISOString());
    return report;
  }

  // Enables the rules for one feed and builds the identity layer. Every old
  // article row stays in place; collisions become quarantined identities so
  // later captures cannot silently pick one side.
  activate(feedId, requestedRules = null) {
    const feed = this.requireFeed(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    // Validate and project first; the feed flag is only persisted once we know
    // the identity layer can be built, so a refused activation leaves the feed
    // exactly as it was.
    const rules = normalizeLinkRules(requestedRules ?? feed.linkRules);
    if (!rules.enabled) {
      return { status: 400, error: "link_rules_disabled", message: "enable linkRules before activating the migration" };
    }
    const projection = this.preview(feedId, rules);
    if (projection.conflicts.length) {
      return { status: 409, error: "unresolvable_url_conflict", conflicts: projection.conflicts };
    }
    this.feeds.saveLinkRules(feedId, rules, this.clock().toISOString());
    const now = this.clock().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let identityCount = 0;
      let quarantineCount = 0;
      const existing = new Map(this.identities.identitiesFor(feedId).map((identity) => [identity.canonicalUrl, identity]));
      const allGroups = [...projection.renames, ...projection.collisions];
      for (const group of allGroups) {
        const collision = group.sources.length > 1;
        let identity = existing.get(group.targetUrl);
        if (!identity) {
          const identityId = this.identities.createIdentity(feedId, group.targetUrl,
            collision ? "quarantined" : "active", now);
          identity = this.identities.identity(identityId);
          identityCount += 1;
        }
        const linkedArticleIds = new Set(this.identities.members(identity.identityId).map((member) => member.articleId));
        group.sources.forEach((source, index) => {
          if (linkedArticleIds.has(source.articleId)) return;
          // The row already carrying the canonical key is the natural primary;
          // legacy-key rows join as aliases. Deterministic by article id otherwise.
          const role = source.canonicalUrl === group.targetUrl ? "primary" : "alias";
          this.identities.addMember(identity.identityId, source.articleId, source.canonicalUrl, role, now);
          if (collision) quarantineCount += 1;
        });
        // Single-source renames have no canonical-key row yet, so seed a primary.
        const members = this.identities.members(identity.identityId);
        if (!members.some((member) => member.role === "primary")) {
          const fallback = members.reduce((oldest, member) =>
            member.articleId < oldest.articleId ? member : oldest, members[0]);
          this.identities.setMemberRole(identity.identityId, fallback.articleId, "primary");
        }
        if (collision && identity.status !== "quarantined") {
          this.identities.setStatus(identity.identityId, "quarantined", now);
        }
      }
      this.identities.recordEvent(feedId, "activate", {
        rules, identityCount, renameCount: projection.renameCount,
        collisionCount: projection.collisions.length, quarantinedMemberCount: quarantineCount
      }, now);
      this.database.exec("COMMIT");
      return {
        status: 200,
        feedId,
        rules,
        identityCount,
        renameCount: projection.renameCount,
        collisionCount: projection.collisions.length,
        quarantinedCount: this.listConflicts(feedId).length
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listConflicts(feedId) {
    const feed = this.requireFeed(feedId);
    if (!feed) return null;
    return this.identities.identitiesFor(feedId)
      .filter((identity) => identity.status === "quarantined")
      .map((identity) => {
        const members = this.identities.members(identity.identityId);
        const reviewStates = new Set(members.map((member) => member.reviewState));
        return {
          identityId: identity.identityId,
          canonicalUrl: identity.canonicalUrl,
          createdAt: identity.createdAt,
          reviewConflict: reviewStates.size > 1,
          reviewStates: [...reviewStates],
          members: members.map((member) => ({
            articleId: member.articleId,
            memberUrl: member.member_url,
            role: member.role,
            title: member.title,
            seenCount: member.seenCount,
            visibility: member.visibility,
            reviewState: member.reviewState,
            reviewNote: member.reviewNote,
            reviewRevision: member.reviewRevision,
            firstSeenAt: member.firstSeenAt,
            lastSeenAt: member.lastSeenAt
          })),
          quarantinedObservations: this.identities.quarantineForIdentity(identity.identityId)
        };
      });
  }

  // Human decision: choose which surviving article row becomes the primary.
  // Nothing is deleted and no review history is rewritten; the losing rows
  // remain aliases with their full observation and review trails.
  resolve(feedId, identityId, input) {
    const feed = this.requireFeed(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    if (!Number.isSafeInteger(identityId) || identityId < 1) throw new TypeError("identityId must be a positive integer");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("resolve request must be an object");
    if (!Number.isSafeInteger(input.primaryArticleId) || input.primaryArticleId < 1) {
      throw new TypeError("primaryArticleId must be a positive integer");
    }
    const identity = this.identities.identity(identityId);
    if (!identity || identity.feedId !== feedId) return { status: 404, error: "identity_not_found" };
    if (identity.status !== "quarantined") {
      return { status: 409, error: "identity_not_quarantined", message: "only quarantined identities can be resolved" };
    }
    const members = this.identities.members(identityId);
    const chosen = members.find((member) => member.articleId === input.primaryArticleId);
    if (!chosen) return { status: 404, error: "article_not_in_identity" };
    const now = this.clock().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const member of members) {
        this.identities.setMemberRole(identityId, member.articleId,
          member.articleId === input.primaryArticleId ? "primary" : "alias");
      }
      this.identities.setStatus(identityId, "active", now);
      this.identities.recordEvent(feedId, "resolve", {
        identityId, primaryArticleId: input.primaryArticleId,
        reason: input.reason ? String(input.reason).slice(0, 500) : null
      }, now);
      this.database.exec("COMMIT");
      return { status: 200, identity: this.identities.identity(identityId), members: this.identities.members(identityId) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // Rollback switches the feed back to the legacy key handling. The identity
  // layer, quarantine evidence, new observations and review events stay on
  // disk, so real history is never undone.
  deactivate(feedId) {
    const feed = this.requireFeed(feedId);
    if (!feed) return { status: 404, error: "feed_not_found" };
    const rules = this.feeds.saveLinkRules(feedId, { ...feed.linkRules, enabled: false }, this.clock().toISOString());
    const remaining = this.identities.identitiesFor(feedId);
    this.identities.recordEvent(feedId, "deactivate", {
      retainedIdentityCount: remaining.length,
      retainedQuarantineCount: remaining.filter((identity) => identity.status === "quarantined").length
    }, this.clock().toISOString());
    return {
      status: 200,
      feedId,
      rules,
      retainedIdentityCount: remaining.length,
      retainedQuarantineCount: remaining.filter((identity) => identity.status === "quarantined").length
    };
  }

  events(feedId, limit) {
    const feed = this.requireFeed(feedId);
    if (!feed) return null;
    return this.identities.events(feedId, limit);
  }

  // Routes one normalized record of a new capture for a rule-enabled feed.
  // Returns the target article row plus whether the observation had to be
  // quarantined because the collision is still unresolved.
  routeRecord(feed, record) {
    const identity = this.identities.identityForUrl(feed.feedId, record.canonicalUrl);
    if (!identity) return { mode: "new", identity: null };
    if (identity.status === "quarantined") return { mode: "quarantine", identity };
    const members = this.identities.members(identity.identityId);
    const primary = members.find((member) => member.role === "primary") ?? members[0];
    return { mode: "identity", identity, primary };
  }
}

function summarizeArticle(article) {
  if (!article) return null;
  return {
    articleId: article.articleId,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    seenCount: article.seenCount,
    visibility: article.visibility,
    reviewState: article.reviewState,
    reviewRevision: article.reviewRevision,
    firstSeenAt: article.firstSeenAt,
    lastSeenAt: article.lastSeenAt
  };
}
