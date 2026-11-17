export class ArticleTimelineService {
  constructor({ feeds, reviews, articles }) {
    this.feeds = feeds;
    this.reviews = reviews;
    this.articles = articles;
  }

  report(feedId, articleId, limit) {
    if (!this.feeds.get(feedId)) return null;
    const article = this.reviews.article(feedId, articleId);
    if (!article) return null;
    const rows = this.articles.timeline(feedId, articleId, limit);
    const observations = rows.map((row, index) => {
      const newer = rows[index - 1];
      const gapMs = newer ? Date.parse(newer.captured_at) - Date.parse(row.captured_at) : null;
      return {
        captureId: row.capture_id,
        capturedAt: row.captured_at,
        sourceIndex: row.source_index,
        observedUrl: row.observed_url ?? null,
        listingSize: row.normalized_count,
        untilNextObservationSeconds: gapMs === null ? null : Number((gapMs / 1000).toFixed(3))
      };
    });
    return {
      article,
      observationCount: observations.length,
      firstObservedAt: observations.at(-1)?.capturedAt ?? null,
      mostRecentlyObservedAt: observations[0]?.capturedAt ?? null,
      observations
    };
  }
}
