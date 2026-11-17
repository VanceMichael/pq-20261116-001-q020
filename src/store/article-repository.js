export class ArticleRepository {
  constructor(database) {
    this.database = database;
    this.upsertArticle = database.prepare(`INSERT INTO articles
      (feed_id, canonical_url, title, published_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, canonical_url) DO UPDATE SET
        title=excluded.title,
        published_at=COALESCE(excluded.published_at, articles.published_at),
        last_seen_at=excluded.last_seen_at,
        seen_count=articles.seen_count+1,
        missing_streak=0,
        visibility='visible'`);
    this.observeExisting = database.prepare(`UPDATE articles SET
        title=?,
        published_at=COALESCE(?, articles.published_at),
        last_seen_at=?,
        seen_count=seen_count+1,
        missing_streak=0,
        visibility='visible'
      WHERE article_id=?`);
    this.getArticleId = database.prepare("SELECT article_id FROM articles WHERE feed_id=? AND canonical_url=?");
    this.getArticleRow = database.prepare(`SELECT a.*, m.identity_id, m.role AS identity_role,
      i.canonical_url AS identity_canonical_url FROM articles a
      LEFT JOIN link_identity_members m ON m.article_id=a.article_id
      LEFT JOIN link_identities i ON i.identity_id=m.identity_id WHERE a.article_id=?`);
    this.insertCaptureItem = database.prepare(`INSERT INTO capture_items
      (capture_id, article_id, source_index, observed_url) VALUES (?, ?, ?, ?)`);
    this.markMissing = database.prepare(`UPDATE articles SET missing_streak=missing_streak+1,
      visibility=CASE WHEN missing_streak+1 >= ? THEN 'quiet' ELSE visibility END
      WHERE feed_id=? AND last_seen_at < ? AND visibility='visible'`);
    this.listArticles = database.prepare(`SELECT a.article_id, a.feed_id, a.canonical_url, a.title, a.published_at,
      a.first_seen_at, a.last_seen_at, a.seen_count, a.missing_streak, a.visibility, a.review_state,
      m.identity_id, m.role AS identity_role, i.canonical_url AS identity_canonical_url
      FROM articles a
      LEFT JOIN link_identity_members m ON m.article_id=a.article_id
      LEFT JOIN link_identities i ON i.identity_id=m.identity_id
      WHERE a.feed_id=? AND (? IS NULL OR a.visibility=?)
      ORDER BY COALESCE(a.published_at, a.last_seen_at) DESC, a.article_id DESC LIMIT ? OFFSET ?`);
    this.countByVisibility = database.prepare(`SELECT visibility, COUNT(*) AS count FROM articles
      WHERE feed_id=? GROUP BY visibility`);
    this.total = database.prepare("SELECT COUNT(*) AS count FROM articles WHERE feed_id=?");
    this.byUrl = database.prepare(`SELECT a.*, m.identity_id, m.role AS identity_role,
      i.canonical_url AS identity_canonical_url FROM articles a
      LEFT JOIN link_identity_members m ON m.article_id=a.article_id
      LEFT JOIN link_identities i ON i.identity_id=m.identity_id
      WHERE a.feed_id=? AND a.canonical_url=?`);
    this.captureArticles = database.prepare(`SELECT a.article_id, a.feed_id, a.canonical_url, a.title,
      a.published_at, a.first_seen_at, a.last_seen_at, a.seen_count, a.missing_streak, a.visibility,
      ci.source_index, ci.observed_url FROM capture_items ci JOIN articles a ON a.article_id=ci.article_id
      WHERE ci.capture_id=? ORDER BY ci.source_index ASC`);
    this.timelineQuery = database.prepare(`SELECT c.capture_id, c.captured_at, c.normalized_count,
      ci.source_index, ci.observed_url FROM capture_items ci JOIN captures c ON c.capture_id=ci.capture_id
      WHERE c.feed_id=? AND ci.article_id=? AND c.accepted=1
      ORDER BY c.capture_id DESC LIMIT ?`);
  }

  recordCapture(captureId, feed, records, capturedAt) {
    const attached = new Set();
    for (const [index, record] of records.entries()) {
      const articleId = this.observeByUrl(feed.feedId, record, capturedAt);
      this.attach(captureId, articleId, record.sourceIndex ?? index, record.observedUrl ?? record.canonicalUrl, attached);
    }
    this.markMissing.run(feed.missingThreshold, feed.feedId, capturedAt);
    return attached.size;
  }

  observeByUrl(feedId, record, capturedAt) {
    this.upsertArticle.run(feedId, record.canonicalUrl, record.title, record.publishedAt, capturedAt, capturedAt);
    return Number(this.getArticleId.get(feedId, record.canonicalUrl).article_id);
  }

  observeArticle(articleId, record, capturedAt) {
    const result = this.observeExisting.run(record.title, record.publishedAt ?? null, capturedAt, articleId);
    if (Number(result.changes) !== 1) throw new Error(`identity primary article ${articleId} disappeared during capture`);
    return articleId;
  }

  attach(captureId, articleId, sourceIndex, observedUrl, attached = new Set()) {
    if (attached.has(articleId)) return false;
    this.insertCaptureItem.run(captureId, articleId, sourceIndex, observedUrl);
    attached.add(articleId);
    return true;
  }

  byId(articleId) {
    const row = this.getArticleRow.get(articleId);
    return row ? mapArticle(row) : null;
  }

  list(feedId, { visibility = null, limit = 50, offset = 0 } = {}) {
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    return this.listArticles.all(feedId, visibility, visibility, pageSize, start).map(mapArticle);
  }

  get(feedId, canonicalUrl) {
    const row = this.byUrl.get(feedId, canonicalUrl);
    return row ? mapArticle(row) : null;
  }

  stats(feedId) {
    const visibility = Object.fromEntries(this.countByVisibility.all(feedId).map((row) => [row.visibility, row.count]));
    return { total: this.total.get(feedId).count, visible: visibility.visible ?? 0, quiet: visibility.quiet ?? 0 };
  }

  forCapture(captureId) {
    return this.captureArticles.all(captureId).map(mapArticle);
  }

  timeline(feedId, articleId, limit = 50) {
    return this.timelineQuery.all(feedId, articleId, Math.max(1, Math.min(200, Number(limit) || 50)));
  }
}

function mapArticle(row) {
  return {
    articleId: row.article_id,
    feedId: row.feed_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    missingStreak: row.missing_streak,
    visibility: row.visibility,
    sourceIndex: row.source_index ?? null,
    observedUrl: row.observed_url ?? null,
    identityId: row.identity_id ?? null,
    identityRole: row.identity_role ?? null,
    identityCanonicalUrl: row.identity_canonical_url ?? null,
    reviewState: row.review_state ?? "unreviewed"
  };
}
