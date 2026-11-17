export class IntegrityAuditService {
  constructor(database) {
    this.database = database;
    this.integrityCheck = database.prepare("PRAGMA integrity_check");
    this.foreignKeyCheck = database.prepare("PRAGMA foreign_key_check");
    this.captureLinkMismatches = database.prepare(`SELECT c.capture_id, c.normalized_count,
      COUNT(ci.article_id) AS linked_count, COALESCE(c.quarantined_count, 0) AS quarantined_count
      FROM captures c
      LEFT JOIN capture_items ci ON ci.capture_id=c.capture_id
      WHERE c.accepted=1 GROUP BY c.capture_id
      HAVING c.normalized_count != COUNT(ci.article_id) + COALESCE(c.quarantined_count, 0)`);
    this.articleCountMismatches = database.prepare(`SELECT a.article_id, a.seen_count,
      COUNT(ci.capture_id) AS observed_count FROM articles a
      LEFT JOIN capture_items ci ON ci.article_id=a.article_id
      GROUP BY a.article_id HAVING a.seen_count != observed_count`);
    this.feedWatermarkMismatches = database.prepare(`SELECT f.feed_id, f.last_accepted_at, f.last_item_count,
      c.captured_at AS expected_at, c.normalized_count AS expected_count
      FROM feeds f LEFT JOIN captures c ON c.capture_id=(
        SELECT capture_id FROM captures WHERE feed_id=f.feed_id AND accepted=1 ORDER BY capture_id DESC LIMIT 1
      ) WHERE (f.last_accepted_at IS NOT c.captured_at) OR (f.last_item_count != COALESCE(c.normalized_count, 0))`);
    this.missingObservedUrls = database.prepare(`SELECT ci.capture_id, ci.article_id FROM capture_items ci
      WHERE ci.observed_url IS NULL OR ci.observed_url = ''`);
    this.identityMemberGaps = database.prepare(`SELECT i.identity_id, i.feed_id, i.status,
      COUNT(m.article_id) AS member_count FROM link_identities i
      LEFT JOIN link_identity_members m ON m.identity_id=i.identity_id
      GROUP BY i.identity_id HAVING member_count = 0`);
    this.quarantineCounterMismatches = database.prepare(`SELECT capture_id, quarantined_count, observed_count FROM (
      SELECT c.capture_id, c.quarantined_count AS quarantined_count,
        (SELECT COUNT(*) FROM quarantined_observations q WHERE q.capture_id=c.capture_id) AS observed_count
      FROM captures c) WHERE quarantined_count != observed_count`);
  }

  run() {
    const checks = [
      { name: "sqlite_integrity", rows: this.integrityCheck.all().filter((row) => row.integrity_check !== "ok") },
      { name: "foreign_keys", rows: this.foreignKeyCheck.all() },
      { name: "capture_item_counts", rows: this.captureLinkMismatches.all() },
      { name: "article_observation_counts", rows: this.articleCountMismatches.all() },
      { name: "feed_watermarks", rows: this.feedWatermarkMismatches.all() },
      { name: "capture_observed_urls", rows: this.missingObservedUrls.all() },
      { name: "link_identity_members", rows: this.identityMemberGaps.all() },
      { name: "quarantine_counters", rows: this.quarantineCounterMismatches.all() }
    ].map((check) => ({
      name: check.name,
      passed: check.rows.length === 0,
      issueCount: check.rows.length,
      examples: check.rows.slice(0, 10)
    }));
    return {
      status: checks.every((check) => check.passed) ? "consistent" : "inconsistent",
      checkedAt: new Date().toISOString(),
      checks
    };
  }
}
