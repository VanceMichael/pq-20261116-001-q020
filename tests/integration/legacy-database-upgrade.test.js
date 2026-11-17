import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeArchive, baseFeed, captureTime, page } from "../helpers.js";

// Builds a genuine v1 database file (old user_version, v1-only schema) and
// fills it with legacy captures, exactly as a pre-upgrade deployment would have.
function createLegacyV1Database(filename) {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE feeds (
      feed_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, allowed_hosts_json TEXT NOT NULL,
      minimum_items INTEGER NOT NULL DEFAULT 3, missing_threshold INTEGER NOT NULL DEFAULT 3,
      last_accepted_at TEXT, last_item_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE captures (
      capture_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      fingerprint TEXT NOT NULL, captured_at TEXT NOT NULL,
      accepted INTEGER NOT NULL CHECK(accepted IN (0, 1)),
      candidate_count INTEGER NOT NULL, normalized_count INTEGER NOT NULL,
      rejected_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL, reason TEXT,
      UNIQUE(feed_id, fingerprint)
    );
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      canonical_url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1, missing_streak INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible', 'quiet')),
      review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed', 'confirmed', 'withdrawn')),
      review_note TEXT, review_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(feed_id, canonical_url)
    );
    CREATE TABLE capture_items (
      capture_id INTEGER NOT NULL REFERENCES captures(capture_id) ON DELETE CASCADE,
      article_id INTEGER NOT NULL REFERENCES articles(article_id), source_index INTEGER NOT NULL,
      PRIMARY KEY(capture_id, article_id)
    );
    CREATE TABLE fetch_attempts (
      attempt_id INTEGER PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(feed_id),
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'rejected', 'not_modified', 'failed')),
      http_status INTEGER, attempt_count INTEGER NOT NULL, requested_url TEXT NOT NULL,
      final_url TEXT, capture_id INTEGER REFERENCES captures(capture_id),
      error_code TEXT, error_message TEXT
    );
    CREATE TABLE review_events (
      event_id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES articles(article_id),
      prior_state TEXT NOT NULL, next_state TEXT NOT NULL, note TEXT,
      revision INTEGER NOT NULL, changed_at TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO feeds VALUES (?, ?, ?, 3, 3, ?, 3, ?, ?)").run(
    baseFeed.feedId, baseFeed.baseUrl, JSON.stringify(baseFeed.allowedHosts),
    captureTime(2), captureTime(1), captureTime(1)
  );
  const insertCapture = database.prepare(`INSERT INTO captures
    (feed_id, fingerprint, captured_at, accepted, candidate_count, normalized_count,
     rejected_count, duplicate_count, reason) VALUES (?, ?, ?, 1, 3, 3, 0, 0, NULL)`);
  const insertArticle = database.prepare(`INSERT INTO articles
    (feed_id, canonical_url, title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`);
  const insertLink = database.prepare("INSERT INTO capture_items(capture_id, article_id, source_index) VALUES (?, ?, ?)");
  const legacyUrls = [1, 2, 3].map((id) => `https://news.example.test/2026/11-16/article-${id}.shtml?item_id=${id}`);
  for (const [captureId, at] of [[1, captureTime(1)], [2, captureTime(2)]]) {
    insertCapture.run(baseFeed.feedId, `fp-${captureId}`, at);
    if (captureId === 1) {
      legacyUrls.forEach((url, index) => insertArticle.run(baseFeed.feedId, url, `旧键${index + 1}`, at, at));
    }
    legacyUrls.forEach((url, index) => {
      const articleId = database.prepare("SELECT article_id FROM articles WHERE canonical_url=?").get(url).article_id;
      if (captureId === 2) database.prepare("UPDATE articles SET seen_count=2, last_seen_at=? WHERE article_id=?").run(at, articleId);
      insertLink.run(captureId, articleId, index);
    });
  }
  database.prepare("INSERT INTO review_events(article_id, prior_state, next_state, revision, changed_at) VALUES (1, 'unreviewed', 'confirmed', 1, ?)").run(captureTime(2));
  database.prepare("UPDATE articles SET review_state='confirmed', review_revision=1 WHERE article_id=1").run();
  database.exec("PRAGMA user_version = 1;");
  database.close();
}

test("a real v1 database upgrades in place and backfills observed-link evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-legacy-v1-"));
  const filename = join(directory, "archive.sqlite");
  createLegacyV1Database(filename);
  const raw = new DatabaseSync(filename);
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('capture_items') WHERE name='observed_url'").get().c, 0);
  raw.close();

  const archive = new (await import("../../src/service/archive.js")).NewsArchive(filename);
  t.after(() => { archive.close(); return rm(directory, { recursive: true, force: true }); });

  assert.equal(archive.database.prepare("PRAGMA user_version").get().user_version, 2);
  // No rows were rewritten or lost in the upgrade.
  assert.equal(archive.articles.stats("daily-main").total, 3);
  const legacy = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(legacy.seenCount, 2);
  assert.equal(legacy.reviewState, "confirmed");
  // Historical evidence is backfilled from the stored canonical URLs.
  const history = archive.articleTimeline("daily-main", legacy.articleId);
  assert.equal(history.observationCount, 2);
  assert.ok(history.observations.every((entry) => entry.observedUrl.includes("item_id=1")));
  // Pre-existing review events survive untouched.
  assert.equal(archive.reviewEvents("daily-main", legacy.articleId).events[0].nextState, "confirmed");
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("legacy-key article queries keep working after the v2 upgrade without enabling any rule", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-legacy-v1-"));
  const filename = join(directory, "archive.sqlite");
  createLegacyV1Database(filename);
  const { NewsArchive } = await import("../../src/service/archive.js");
  const opened = new NewsArchive(filename);
  t.after(() => { opened.close(); return rm(directory, { recursive: true, force: true }); });

  // Rules stay off: new captures still use the legacy key and land on the same rows.
  assert.equal(opened.feeds.get("daily-main").linkRules.enabled, false);
  const repeated = opened.importSnapshot("daily-main",
    page([1, 2, 3].map((id) => ({ id, url: `/2026/11-16/article-${id}.shtml?item_id=${id}` }))) + "<!-- legacy -->",
    captureTime(3));
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.quarantinedCount, 0);
  assert.equal(opened.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1").seenCount, 3);
  assert.equal(opened.articles.stats("daily-main").total, 3);
});

test("a v1 database can be previewed and migrated with every collision safeguard intact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "news-legacy-v1-"));
  const filename = join(directory, "archive.sqlite");
  createLegacyV1Database(filename);
  const { NewsArchive } = await import("../../src/service/archive.js");
  const archive = new NewsArchive(filename);
  t.after(() => { archive.close(); return rm(directory, { recursive: true, force: true }); });

  const preview = archive.previewLinkRules("daily-main",
    { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] });
  assert.equal(preview.renameCount, 3);
  assert.equal(preview.collisionCount, 0);
  const activated = archive.activateLinkRules("daily-main",
    { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] });
  assert.equal(activated.status, 200);
  assert.equal(activated.identityCount, 3);
  assert.equal(archive.auditIntegrity().status, "consistent");
});
