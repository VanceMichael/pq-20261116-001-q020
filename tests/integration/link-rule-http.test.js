import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, baseFeed, captureTime, page } from "../helpers.js";
import { createHttpServer } from "../../src/http/server.js";

const RULES = { enabled: true, canonicalKey: "item", aliasKeys: ["item_id"] };
const STORY = "/2026/11-16/article-3.shtml";

async function start(t, archive) {
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  return base;
}

function legacyPage() {
  return page([
    { id: 1, url: "/2026/11-16/article-1.shtml?item_id=1" },
    { id: 2, url: "/2026/11-16/article-2.shtml?item_id=2" },
    { id: 3, url: `${STORY}?item_id=3`, title: "甲版本" },
    { id: 30, url: `${STORY}?item=3`, title: "乙版本" }
  ]);
}

test("exposes the preview, activate, conflicts, resolve and rollback lifecycle over HTTP", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", legacyPage(), captureTime(1));
  const base = await start(t, archive);

  const preview = await fetch(`${base}/v1/feeds/daily-main/link-rules/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: RULES })
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.collisionCount, 1);
  assert.equal(previewBody.renameCount, 2);

  const activate = await fetch(`${base}/v1/feeds/daily-main/link-rules/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: RULES })
  });
  assert.equal(activate.status, 200);
  assert.equal((await activate.json()).quarantinedCount, 1);

  const conflicts = await fetch(`${base}/v1/feeds/daily-main/link-rules/conflicts`);
  const conflictBody = await conflicts.json();
  assert.equal(conflicts.status, 200);
  assert.equal(conflictBody.conflicts.length, 1);
  const identityId = conflictBody.conflicts[0].identityId;
  const winner = conflictBody.conflicts[0].members.find((member) => member.title === "乙版本");

  const resolve = await fetch(`${base}/v1/feeds/daily-main/link-rules/conflicts/${identityId}/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ primaryArticleId: winner.articleId, reason: "api resolve" })
  });
  assert.equal(resolve.status, 200);
  assert.equal((await fetch(`${base}/v1/feeds/daily-main/link-rules/conflicts`)).status, 200);
  assert.equal((await (await fetch(`${base}/v1/feeds/daily-main/link-rules/conflicts`)).json()).conflicts.length, 0);

  const events = await fetch(`${base}/v1/feeds/daily-main/link-rules/events?limit=10`);
  const eventBody = await events.json();
  const eventTypes = eventBody.events.map((event) => event.eventType);
  assert.ok(eventTypes.includes("preview"));
  assert.ok(eventTypes.includes("activate"));
  assert.ok(eventTypes.includes("resolve"));

  const rollback = await fetch(`${base}/v1/feeds/daily-main/link-rules/rollback`, { method: "POST" });
  assert.equal(rollback.status, 200);
  const rollbackBody = await rollback.json();
  assert.equal(rollbackBody.rules.enabled, false);
  assert.ok(rollbackBody.retainedIdentityCount >= 3);
});

test("quarantines a new-key capture over HTTP until the collision is resolved", async (t) => {
  const { archive } = await makeArchive(t);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", legacyPage(), captureTime(1));
  const base = await start(t, archive);
  await fetch(`${base}/v1/feeds/daily-main/link-rules/activate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules: RULES })
  });
  const modern = page([
    { id: 1, url: "/2026/11-16/article-1.shtml?item=1" },
    { id: 2, url: "/2026/11-16/article-2.shtml?item=2" },
    { id: 3, url: `${STORY}?item=3` }
  ], { titlePrefix: "新键" }) + "<!-- modern batch -->";
  const snapshot = await fetch(`${base}/v1/feeds/daily-main/snapshots`, {
    method: "POST", headers: { "X-Captured-At": captureTime(2) }, body: modern
  });
  assert.equal(snapshot.status, 202);
  const body = await snapshot.json();
  assert.equal(body.quarantinedCount, 1);
  assert.equal(body.quarantined[0].canonicalUrl, `https://news.example.test${STORY}?item=3`);
});

test("link rule routes return not found for unknown feeds and reject malformed resolve input", async (t) => {
  const { archive } = await makeArchive(t);
  const base = await start(t, archive);
  assert.equal((await fetch(`${base}/v1/feeds/missing/link-rules/conflicts`)).status, 404);
  const rollback = await fetch(`${base}/v1/feeds/missing/link-rules/rollback`, { method: "POST" });
  assert.equal(rollback.status, 404);
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", legacyPage(), captureTime(1));
  const badResolve = await fetch(`${base}/v1/feeds/daily-main/link-rules/conflicts/999/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
  });
  assert.equal(badResolve.status, 400);
});
