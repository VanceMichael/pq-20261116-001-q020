import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page, standardItems } from "../helpers.js";

test("reports a fresh archive as consistent across SQLite and application invariants", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(5)), captureTime(1));
  const report = archive.auditIntegrity();
  assert.equal(report.status, "consistent");
  assert.ok(report.checks.every((check) => check.passed));
  assert.deepEqual(report.checks.map((check) => check.name), [
    "sqlite_integrity", "foreign_keys", "capture_item_counts", "article_observation_counts", "feed_watermarks",
    "capture_observed_urls", "link_identity_members", "quarantine_counters"
  ]);
});

test("detects a missing capture link instead of trusting only SQLite page health", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.database.prepare("DELETE FROM capture_items WHERE capture_id=1 AND source_index=0").run();
  const report = archive.auditIntegrity();
  assert.equal(report.status, "inconsistent");
  const captureCheck = report.checks.find((check) => check.name === "capture_item_counts");
  assert.equal(captureCheck.issueCount, 1);
  assert.equal(captureCheck.examples[0].linked_count, 3);
});

test("detects an article observation counter that no longer matches its history", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  archive.importSnapshot("daily-main", `${page(standardItems(4))}\n<!-- another pass -->`, captureTime(2));
  archive.database.prepare("UPDATE articles SET seen_count=90 WHERE article_id=1").run();
  const report = archive.auditIntegrity();
  const countCheck = report.checks.find((check) => check.name === "article_observation_counts");
  assert.equal(countCheck.passed, false);
  assert.equal(countCheck.examples[0].seen_count, 90);
  assert.equal(countCheck.examples[0].observed_count, 2);
});

test("detects a feed summary watermark that diverges from its newest accepted capture", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  archive.database.prepare("UPDATE feeds SET last_item_count=88 WHERE feed_id='daily-main'").run();
  const report = archive.auditIntegrity();
  const watermarkCheck = report.checks.find((check) => check.name === "feed_watermarks");
  assert.equal(watermarkCheck.passed, false);
  assert.equal(watermarkCheck.examples[0].expected_count, 3);
});

test("includes isolated feeds with no captures in a consistent initial state", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  const report = archive.auditIntegrity();
  assert.equal(report.status, "consistent");
});
