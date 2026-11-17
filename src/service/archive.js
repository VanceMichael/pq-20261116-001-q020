import { openDatabase, closeDatabase } from "../store/database.js";
import { FeedRepository } from "../store/feed-repository.js";
import { CaptureRepository } from "../store/capture-repository.js";
import { ArticleRepository } from "../store/article-repository.js";
import { FetchRepository } from "../store/fetch-repository.js";
import { ImportService } from "../ingest/import-service.js";
import { PageFetcher } from "../acquisition/page-fetcher.js";
import { RefreshService } from "./refresh-service.js";
import { ChangeReportService } from "./change-report.js";
import { HealthReportService } from "./health-report.js";
import { ReviewRepository } from "../store/review-repository.js";
import { ReviewService } from "./review-service.js";
import { CsvExporter } from "../export/csv-exporter.js";
import { ArticleTimelineService } from "./article-timeline.js";
import { IntegrityAuditService } from "./integrity-audit.js";
import { LinkIdentityRepository } from "../store/link-identity-repository.js";
import { LinkRuleService } from "./link-rule-service.js";

export class NewsArchive {
  constructor(filename, options = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.database = openDatabase(filename);
    this.feeds = new FeedRepository(this.database);
    this.captures = new CaptureRepository(this.database);
    this.articles = new ArticleRepository(this.database);
    this.fetches = new FetchRepository(this.database);
    this.reviews = new ReviewRepository(this.database);
    this.identities = new LinkIdentityRepository(this.database);
    this.linkRuleService = new LinkRuleService({
      database: this.database,
      feeds: this.feeds,
      identities: this.identities,
      articles: this.articles,
      clock: this.clock
    });
    this.imports = new ImportService({
      database: this.database,
      feeds: this.feeds,
      captures: this.captures,
      articles: this.articles,
      linkRules: this.linkRuleService,
      clock: this.clock
    });
    this.refreshes = new RefreshService({
      feeds: this.feeds,
      fetches: this.fetches,
      fetcher: options.fetcher ?? new PageFetcher(),
      imports: this.imports,
      clock: this.clock
    });
    this.changes = new ChangeReportService({ feeds: this.feeds, captures: this.captures, articles: this.articles });
    this.health = new HealthReportService({ feeds: this.feeds, fetches: this.fetches, clock: this.clock });
    this.reviewService = new ReviewService({ feeds: this.feeds, reviews: this.reviews, clock: this.clock });
    this.csvExporter = new CsvExporter({ database: this.database, feeds: this.feeds, articles: this.articles });
    this.timelines = new ArticleTimelineService({ feeds: this.feeds, reviews: this.reviews, articles: this.articles });
    this.integrityAudit = new IntegrityAuditService(this.database);
  }

  registerFeed(input) {
    return this.feeds.register(input, this.now());
  }

  previewLinkRules(feedId, rules) {
    return this.linkRuleService.preview(feedId, rules);
  }

  activateLinkRules(feedId, rules) {
    return this.linkRuleService.activate(feedId, rules);
  }

  listLinkConflicts(feedId) {
    return this.linkRuleService.listConflicts(feedId);
  }

  resolveLinkConflict(feedId, identityId, input) {
    return this.linkRuleService.resolve(feedId, identityId, input);
  }

  deactivateLinkRules(feedId) {
    return this.linkRuleService.deactivate(feedId);
  }

  linkRuleEvents(feedId, limit) {
    return this.linkRuleService.events(feedId, limit);
  }

  importSnapshot(feedId, html, capturedAt) {
    return this.imports.importHtml(feedId, html, capturedAt);
  }

  refreshFeed(feedId) {
    return this.refreshes.refresh(feedId);
  }

  feedStatus(feedId) {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const latest = this.captures.recent(feedId, 1)[0] ?? null;
    return {
      ...feed,
      health: latest ? latest.accepted ? "healthy" : "degraded" : "awaiting_capture",
      latestAttempt: latest,
      statistics: this.articles.stats(feedId),
      collectionHealth: this.health.report(feedId)
    };
  }

  listItems(feedId, options) {
    if (!this.feeds.get(feedId)) return null;
    return { items: this.articles.list(feedId, options), statistics: this.articles.stats(feedId) };
  }

  listCaptures(feedId, limit) {
    if (!this.feeds.get(feedId)) return null;
    return this.captures.recent(feedId, limit);
  }

  listFetchAttempts(feedId, limit) {
    return this.refreshes.recent(feedId, limit);
  }

  feedChanges(feedId) {
    return this.changes.report(feedId);
  }

  feedHealth(feedId) {
    return this.health.report(feedId);
  }

  reviewArticle(feedId, articleId, input) {
    return this.reviewService.change(feedId, articleId, input);
  }

  reviewEvents(feedId, articleId, limit) {
    return this.reviewService.events(feedId, articleId, limit);
  }

  exportCsv(feedId, writable, options) {
    return this.csvExporter.write(feedId, writable, options);
  }

  articleTimeline(feedId, articleId, limit) {
    return this.timelines.report(feedId, articleId, limit);
  }

  auditIntegrity() {
    return this.integrityAudit.run();
  }

  close() {
    closeDatabase(this.database);
  }

  now() {
    return this.clock().toISOString();
  }
}
