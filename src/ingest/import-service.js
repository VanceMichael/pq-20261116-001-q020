import { extractLinks, pageFingerprint } from "../feed/html.js";
import { normalizeCandidates } from "../feed/normalize.js";
import { validateFeedId } from "../store/feed-repository.js";
import { assessCapture, validateCapturedAt } from "./capture-policy.js";

export class ImportService {
  constructor({ database, feeds, captures, articles, linkRules = null, clock = () => new Date() }) {
    this.database = database;
    this.feeds = feeds;
    this.captures = captures;
    this.articles = articles;
    this.linkRules = linkRules;
    this.clock = clock;
  }

  importHtml(feedId, html, capturedAtValue) {
    validateFeedId(feedId);
    const feed = this.feeds.get(feedId);
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const capturedAt = validateCapturedAt(capturedAtValue, this.clock());
    const fingerprint = pageFingerprint(html);
    const previous = this.captures.findByFingerprint(feedId, fingerprint);
    if (previous) return { ...previous, replay: true, stats: this.articles.stats(feedId) };

    const rulesEnabled = Boolean(feed.linkRules?.enabled);
    const candidates = extractLinks(html, feed.baseUrl);
    const normalized = normalizeCandidates(candidates, {
      baseUrl: feed.baseUrl,
      allowedHosts: feed.allowedHosts,
      linkRules: rulesEnabled ? feed.linkRules : null
    });
    const policy = assessCapture({
      candidateCount: candidates.length,
      normalizedCount: normalized.records.length,
      rejectedCount: normalized.rejected.length,
      previousCount: feed.lastItemCount,
      capturedAt,
      feed
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const captureId = this.captures.create({
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        reason: policy.reason
      });
      let quarantine = [];
      if (policy.accepted) {
        const outcome = rulesEnabled && this.linkRules
          ? this.recordWithRules(captureId, feed, normalized.records, capturedAt)
          : { quarantine: [] };
        if (!rulesEnabled) this.articles.recordCapture(captureId, feed, normalized.records, capturedAt);
        quarantine = outcome.quarantine;
        this.captures.setQuarantinedCount(captureId, quarantine.length);
        this.feeds.markAccepted(feedId, capturedAt, normalized.records.length);
      }
      this.database.exec("COMMIT");
      return {
        captureId,
        feedId,
        fingerprint,
        capturedAt,
        accepted: policy.accepted,
        replay: false,
        candidateCount: candidates.length,
        normalizedCount: normalized.records.length,
        rejectedCount: normalized.rejected.length,
        duplicateCount: normalized.duplicateCount,
        quarantinedCount: quarantine.length,
        quarantined: quarantine,
        reason: policy.reason,
        rejected: normalized.rejected,
        stats: this.articles.stats(feedId)
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordWithRules(captureId, feed, records, capturedAt) {
    const attached = new Set();
    const quarantine = [];
    for (const [index, record] of records.entries()) {
      const sourceIndex = record.sourceIndex ?? index;
      const route = this.linkRules.routeRecord(feed, record);
      if (route.mode === "quarantine") {
        // The collision is still unresolved: keep the new observation but
        // never overwrite either of the competing article rows.
        this.linkRules.identities.quarantineObservation({
          feedId: feed.feedId,
          identityId: route.identity.identityId,
          captureId,
          sourceIndex,
          observedUrl: record.observedUrl,
          canonicalUrl: record.canonicalUrl,
          title: record.title,
          publishedAt: record.publishedAt,
          observedAt: capturedAt
        });
        quarantine.push({ identityId: route.identity.identityId, sourceIndex,
          observedUrl: record.observedUrl, canonicalUrl: record.canonicalUrl, title: record.title });
        continue;
      }
      if (route.mode === "identity") {
        const articleId = this.articles.observeArticle(route.primary.articleId, record, capturedAt);
        this.articles.attach(captureId, articleId, sourceIndex, record.observedUrl, attached);
      } else {
        const articleId = this.articles.observeByUrl(feed.feedId, record, capturedAt);
        this.articles.attach(captureId, articleId, sourceIndex, record.observedUrl, attached);
      }
    }
    this.articles.markMissing.run(feed.missingThreshold, feed.feedId, capturedAt);
    return { quarantine };
  }
}
