import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page } from "../helpers.js";

const enabledRules = { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] };
const STORY = "/2026/11-16/article-3.shtml";

function legacy(id) {
  return `/2026/11-16/article-${id}.shtml?item_id=${id}`;
}

function modern(id) {
  return `/2026/11-16/article-${id}.shtml?item=${id}`;
}

function legacyPage(ids, suffix = "") {
  return page(ids.map((id) => ({ id, url: legacy(id) })), { titlePrefix: "旧键" }) + suffix;
}

function modernPage(ids, suffix = "") {
  return page(ids.map((id) => ({ id, url: modern(id) })), { titlePrefix: "新键" }) + suffix;
}

// Two distinct article rows whose URLs only differ by the legacy/canonical key.
function collisionPage(extra = []) {
  return page([
    { id: 3, url: `${STORY}?item_id=3`, title: "甲版本" },
    { id: 30, url: `${STORY}?item=3`, title: "乙版本" },
    ...extra
  ]);
}

async function seededLegacy(t) {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  return { archive };
}

test("preview is read-only: reports renames, collisions and opposing reviews without mutating rows", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2]), captureTime(1));
  archive.importSnapshot("daily-main", collisionPage([
    { id: 1, url: legacy(1) },
    { id: 2, url: legacy(2) }
  ]) + "<!-- second -->", captureTime(2));
  const before = archive.articles.stats("daily-main");
  const preview = archive.previewLinkRules("daily-main", enabledRules);
  assert.equal(preview.storedArticleCount, before.total);
  assert.ok(preview.renameCount >= 2);
  const collision = preview.collisions.find((entry) => entry.targetUrl === `https://news.example.test${STORY}?item=3`);
  assert.ok(collision);
  assert.deepEqual(collision.sources.map((source) => source.title).sort(), ["乙版本", "甲版本"]);
  // No identity rows yet, article rows unchanged.
  assert.deepEqual(archive.identities.identitiesFor("daily-main"), []);
  assert.equal(archive.articles.stats("daily-main").total, before.total);
  assert.equal(archive.linkRuleEvents("daily-main")[0].eventType, "preview");
});

test("activation only changes feeds that explicitly enable the rules", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  const disabled = archive.activateLinkRules("daily-main", { ...enabledRules, enabled: false });
  assert.equal(disabled.status, 400);
  assert.equal(archive.feeds.get("daily-main").linkRules.enabled, false);
  // Another feed never receives any rule objects.
  archive.registerFeed({ ...baseFeed, feedId: "other-feed" });
  assert.equal(archive.feeds.get("other-feed").linkRules.enabled, false);
  assert.deepEqual(archive.identities.identitiesFor("other-feed"), []);
});

test("activation renames safe legacy keys through an identity while keeping the original article row", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  const activated = archive.activateLinkRules("daily-main", enabledRules);
  assert.equal(activated.status, 200);
  assert.equal(activated.collisionCount, 0);
  assert.equal(activated.quarantinedCount, 0);
  const identities = archive.identities.identitiesFor("daily-main");
  assert.equal(identities.length, 3);
  assert.ok(identities.every((identity) => identity.status === "active"));
  // Article row, its URL and full history are preserved untouched.
  const legacyArticle = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(legacyArticle.title, "旧键1");
  assert.equal(legacyArticle.identityRole, "primary");
  assert.equal(legacyArticle.identityCanonicalUrl,
    "https://news.example.test/2026/11-16/article-1.shtml?item=1");
});

test("colliding legacy rows with opposing reviews are both retained and flagged for human resolution", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", collisionPage([
    { id: 1, url: legacy(1) },
    { id: 2, url: legacy(2) }
  ]), captureTime(1));
  const items = archive.listItems("daily-main").items;
  const first = items.find((item) => item.title === "甲版本");
  const second = items.find((item) => item.title === "乙版本");
  archive.reviewArticle("daily-main", first.articleId, { state: "confirmed", expectedRevision: 0 });
  archive.reviewArticle("daily-main", second.articleId, { state: "withdrawn", expectedRevision: 0 });
  const activated = archive.activateLinkRules("daily-main", enabledRules);
  assert.equal(activated.collisionCount, 1);
  assert.equal(activated.quarantinedCount, 1);
  const [conflict] = archive.listLinkConflicts("daily-main");
  assert.equal(conflict.reviewConflict, true);
  assert.deepEqual([...conflict.reviewStates].sort(), ["confirmed", "withdrawn"]);
  assert.equal(conflict.members.length, 2);
  assert.ok(conflict.members.every((member) => member.seenCount === 1));
  // Both review event trails are still independently readable.
  for (const member of conflict.members) {
    const events = archive.reviewEvents("daily-main", member.articleId).events;
    assert.equal(events.length, 1);
  }
});

test("new captures on an unresolved collision are quarantined instead of overwriting either row", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", collisionPage([
    { id: 1, url: legacy(1) },
    { id: 2, url: legacy(2) }
  ]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  const incoming = archive.importSnapshot("daily-main", modernPage([1, 2, 3], "<!-- fresh -->"), captureTime(2));
  assert.equal(incoming.accepted, true);
  assert.equal(incoming.quarantinedCount, 1);
  const [conflict] = archive.listLinkConflicts("daily-main");
  assert.equal(conflict.quarantinedObservations.length, 1);
  assert.equal(conflict.quarantinedObservations[0].observedUrl,
    `https://news.example.test${STORY}?item=3`);
  assert.equal(conflict.quarantinedObservations[0].canonicalUrl,
    `https://news.example.test${STORY}?item=3`);
  // Neither legacy article gained an observation or a title overwrite.
  const titles = conflict.members.map((member) => member.title).sort();
  assert.deepEqual(titles, ["乙版本", "甲版本"]);
  assert.ok(conflict.members.every((member) => member.seenCount === 1));
  // The safe articles did receive the new-key observation on the same identity.
  const safe = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(safe.seenCount, 2);
});

test("resolving a collision routes later observations to the chosen primary and keeps the alias trail", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", collisionPage([{ id: 1, url: legacy(1) }]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  const [conflict] = archive.listLinkConflicts("daily-main");
  const winner = conflict.members.find((member) => member.title === "乙版本");
  const resolved = archive.resolveLinkConflict("daily-main", conflict.identityId, {
    primaryArticleId: winner.articleId, reason: "编辑确认乙版本为正式稿"
  });
  assert.equal(resolved.status, 200);
  assert.equal(archive.listLinkConflicts("daily-main").length, 0);
  const members = archive.identities.members(conflict.identityId);
  assert.equal(members.find((member) => member.role === "primary").articleId, winner.articleId);
  assert.ok(members.some((member) => member.role === "alias"));
  // The alias row and its review history are not deleted.
  const alias = members.find((member) => member.role === "alias");
  assert.ok(archive.articles.byId(alias.articleId));
  const next = archive.importSnapshot("daily-main", modernPage([1, 2, 3], "<!-- after resolve -->"), captureTime(2));
  assert.equal(next.quarantinedCount, 0);
  const updatedWinner = archive.articles.byId(winner.articleId);
  assert.equal(updatedWinner.seenCount, 2);
  assert.equal(updatedWinner.title, "新键3");
  const untouchedAlias = archive.articles.byId(alias.articleId);
  assert.equal(untouchedAlias.seenCount, 1);
  assert.equal(untouchedAlias.title, "甲版本");
});

test("historical snapshots still locate the source link observed at capture time", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  archive.importSnapshot("daily-main", modernPage([1, 2, 3], "<!-- recapture -->"), captureTime(2));
  const legacyArticle = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  const history = archive.articleTimeline("daily-main", legacyArticle.articleId);
  assert.equal(history.observationCount, 2);
  const [newer, older] = history.observations;
  assert.equal(older.observedUrl, "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(newer.observedUrl, "https://news.example.test/2026/11-16/article-1.shtml?item=1");});

test("rollback restores legacy key handling without erasing new observations or human decisions", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  archive.importSnapshot("daily-main", modernPage([1, 2, 3], "<!-- new era -->"), captureTime(2));
  const beforeRollback = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  const rollback = archive.deactivateLinkRules("daily-main");
  assert.equal(rollback.status, 200);
  assert.equal(rollback.retainedIdentityCount, 3);
  assert.equal(archive.feeds.get("daily-main").linkRules.enabled, false);
  // A post-rollback capture with the old key is stored the legacy way, no identity routing.
  const legacyAgain = archive.importSnapshot("daily-main", legacyPage([1, 2, 3], "<!-- rolled back -->"), captureTime(3));
  assert.equal(legacyAgain.quarantinedCount, 0);
  const after = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(after.seenCount, beforeRollback.seenCount + 1);
  // The identity layer and audit trail survive for inspection.
  assert.equal(archive.identities.identitiesFor("daily-main").length, 3);
  assert.ok(archive.linkRuleEvents("daily-main").some((event) => event.eventType === "deactivate"));
  assert.equal(archive.auditIntegrity().status, "consistent");
});

test("re-activation after rollback reuses existing identities instead of duplicating them", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  archive.deactivateLinkRules("daily-main");
  const second = archive.activateLinkRules("daily-main", enabledRules);
  assert.equal(second.status, 200);
  assert.equal(second.identityCount, 0);
  assert.equal(archive.identities.identitiesFor("daily-main").length, 3);
});

test("integrity audit covers observed URL evidence, identity membership and quarantine counters", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  assert.equal(archive.auditIntegrity().status, "consistent");
  archive.database.prepare("UPDATE capture_items SET observed_url=NULL WHERE capture_id=1 AND source_index=0").run();
  const report = archive.auditIntegrity();
  assert.equal(report.status, "inconsistent");
  assert.equal(report.checks.find((check) => check.name === "capture_observed_urls").issueCount, 1);
});

test("an enabled feed still strips tracking parameters while applying the identity rule", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", page([
    { id: 1, url: "/2026/11-16/article-1.shtml?item_id=1&utm_source=feed&from=app" },
    { id: 2, url: legacy(2) },
    { id: 3, url: legacy(3) }
  ]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  const article = archive.articles.get("daily-main",
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
  assert.equal(article.identityCanonicalUrl, "https://news.example.test/2026/11-16/article-1.shtml?item=1");
  const timeline = archive.articleTimeline("daily-main", article.articleId);
  assert.equal(timeline.observations[0].observedUrl,
    "https://news.example.test/2026/11-16/article-1.shtml?item_id=1");
});

test("refuses activation when a stored URL carries competing business numbers", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", page([
    { id: 1, url: "/2026/11-16/clash.shtml?item_id=5&item=6", title: "自相矛盾稿件" },
    { id: 2, url: legacy(2) },
    { id: 3, url: legacy(3) }
  ]), captureTime(1));
  const result = archive.activateLinkRules("daily-main", enabledRules);
  assert.equal(result.status, 409);
  assert.equal(result.error, "unresolvable_url_conflict");
  assert.match(result.conflicts[0].reason, /competing business numbers/);
  // No partial identity layer is left behind, and the feed flag stays disabled.
  assert.deepEqual(archive.identities.identitiesFor("daily-main"), []);
  assert.equal(archive.feeds.get("daily-main").linkRules.enabled, false);
});

test("resolving an already active identity is rejected without changing roles", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", collisionPage([{ id: 1, url: legacy(1) }]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  const [conflict] = archive.listLinkConflicts("daily-main");
  const winner = conflict.members.find((member) => member.title === "乙版本");
  const alias = conflict.members.find((member) => member.title === "甲版本");
  archive.resolveLinkConflict("daily-main", conflict.identityId, { primaryArticleId: winner.articleId });
  const again = archive.resolveLinkConflict("daily-main", conflict.identityId, { primaryArticleId: alias.articleId });
  assert.equal(again.status, 409);
  assert.equal(again.error, "identity_not_quarantined");
  const members = archive.identities.members(conflict.identityId);
  assert.equal(members.find((member) => member.role === "primary").articleId, winner.articleId);
});

test("a new capture containing a self-conflicting URL rejects that link instead of choosing a value", async (t) => {
  const { archive } = await seededLegacy(t);
  archive.importSnapshot("daily-main", legacyPage([1, 2, 3]), captureTime(1));
  archive.activateLinkRules("daily-main", enabledRules);
  const result = archive.importSnapshot("daily-main", page([
    { id: 1, url: modern(1) },
    { id: 2, url: modern(2) },
    { id: 9, url: "/2026/11-16/clash.shtml?item_id=5&item=6", title: "矛盾新稿" }
  ]) + "<!-- clash -->", captureTime(2));
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /competing business numbers/);
  assert.equal(result.stats.total, 3);
});
