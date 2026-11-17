import { createServer } from "node:http";
import { URL } from "node:url";
import { validateFeedId } from "../store/feed-repository.js";

const BODY_LIMIT = 5 * 1024 * 1024;

export function createHttpServer(archive, { host = "127.0.0.1", port = 8080, logger = console } = {}) {
  const server = createServer(async (request, response) => {
    const requestId = request.headers["x-request-id"]?.slice(0, 100) || crypto.randomUUID();
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Cache-Control", "no-store");
    try {
      await routeRequest(request, response, archive);
    } catch (error) {
      const status = error.statusCode ?? (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
      if (status >= 500) logger.error?.({ requestId, error: error.message });
      if (response.headersSent) return response.destroy(error);
      writeJson(response, status, { error: status >= 500 ? "internal_error" : "invalid_request", message: error.message });
    }
  });
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function routeRequest(request, response, archive) {
  const url = new URL(request.url, "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (request.method === "GET" && url.pathname === "/health") {
    return writeJson(response, 200, { status: "ok", service: "rolling-news-archive" });
  }
  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "feeds" && request.method === "POST") {
    const input = await readJson(request);
    const feed = archive.registerFeed(input);
    return writeJson(response, 201, { feed });
  }
  if (segments[0] !== "v1" || segments[1] !== "feeds" || !segments[2]) return notFound(response);
  const feedId = segments[2];
  validateFeedId(feedId);
  if (segments.length === 4 && segments[3] === "snapshots" && request.method === "POST") {
    const html = await readText(request);
    const result = archive.importSnapshot(feedId, html, request.headers["x-captured-at"]);
    return writeJson(response, result.accepted ? result.replay ? 200 : 202 : 422, result);
  }
  if (segments.length === 4 && segments[3] === "refresh" && request.method === "POST") {
    const result = await archive.refreshFeed(feedId);
    const status = result.outcome === "accepted" ? result.capture.replay ? 200 : 202 : result.outcome === "not_modified" ? 200 : 422;
    return writeJson(response, status, result);
  }
  if (segments.length === 3 && request.method === "GET") {
    const result = archive.feedStatus(feedId);
    return result ? writeJson(response, 200, result) : notFound(response);
  }
  if (segments.length === 4 && segments[3] === "items" && request.method === "GET") {
    const visibility = url.searchParams.get("visibility");
    if (visibility && !new Set(["visible", "quiet"]).has(visibility)) {
      throw new TypeError("visibility must be visible or quiet");
    }
    const result = archive.listItems(feedId, {
      visibility,
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    return result ? writeJson(response, 200, result) : notFound(response);
  }
  if (segments.length === 4 && segments[3] === "items.csv" && request.method === "GET") {
    if (!archive.feedStatus(feedId)) return notFound(response);
    const visibility = url.searchParams.get("visibility");
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${feedId}-items.csv"`,
      "Cache-Control": "no-store"
    });
    const result = await archive.exportCsv(feedId, response, { visibility, limit: url.searchParams.get("limit") ?? 50_000 });
    if (!result.found) return notFound(response);
    response.end();
    return;
  }
  if (segments.length === 4 && segments[3] === "runs" && request.method === "GET") {
    const result = archive.listCaptures(feedId, url.searchParams.get("limit"));
    return result ? writeJson(response, 200, { runs: result }) : notFound(response);
  }
  if (segments.length === 4 && segments[3] === "attempts" && request.method === "GET") {
    const result = archive.listFetchAttempts(feedId, url.searchParams.get("limit"));
    return result ? writeJson(response, 200, { attempts: result }) : notFound(response);
  }
  if (segments.length === 4 && segments[3] === "changes" && request.method === "GET") {
    const result = archive.feedChanges(feedId);
    return result ? writeJson(response, result.ready ? 200 : 409, result) : notFound(response);
  }
  if (segments.length === 4 && segments[3] === "health" && request.method === "GET") {
    const result = archive.feedHealth(feedId);
    return result ? writeJson(response, 200, result) : notFound(response);
  }
  if (segments.length === 6 && segments[3] === "items" && segments[5] === "review") {
    const articleId = Number(segments[4]);
    if (request.method === "PATCH") {
      const result = archive.reviewArticle(feedId, articleId, await readJson(request));
      return writeJson(response, result.status, result);
    }
    if (request.method === "GET") {
      const result = archive.reviewEvents(feedId, articleId, url.searchParams.get("limit"));
      return result ? writeJson(response, 200, result) : notFound(response);
    }
  }
  if (segments.length === 6 && segments[3] === "items" && segments[5] === "history" && request.method === "GET") {
    const articleId = Number(segments[4]);
    const result = archive.articleTimeline(feedId, articleId, url.searchParams.get("limit"));
    return result ? writeJson(response, 200, result) : notFound(response);
  }
  if (segments.length >= 5 && segments[3] === "link-rules") {
    return routeLinkRules(request, response, archive, feedId, segments, url);
  }
  return notFound(response);
}

async function routeLinkRules(request, response, archive, feedId, segments, url) {
  const action = segments[4];
  if (action === "preview" && request.method === "POST") {
    const body = await readJson(request);
    const result = archive.previewLinkRules(feedId, body.rules ?? null);
    return result ? writeJson(response, 200, result) : notFound(response);
  }
  if (action === "activate" && request.method === "POST") {
    const body = await readJson(request);
    const result = archive.activateLinkRules(feedId, body.rules ?? null);
    if (result.status === 404) return notFound(response);
    return writeJson(response, result.status === 200 ? 200 : result.status, result);
  }
  if (action === "conflicts" && request.method === "GET") {
    const result = archive.listLinkConflicts(feedId);
    return result ? writeJson(response, 200, { conflicts: result }) : notFound(response);
  }
  if (action === "rollback" && request.method === "POST") {
    const result = archive.deactivateLinkRules(feedId);
    if (result.status === 404) return notFound(response);
    return writeJson(response, 200, result);
  }
  if (action === "events" && request.method === "GET") {
    const result = archive.linkRuleEvents(feedId, url.searchParams.get("limit"));
    return result ? writeJson(response, 200, { events: result }) : notFound(response);
  }
  if (segments.length === 7 && action === "conflicts" && segments[6] === "resolve" && request.method === "POST") {
    const identityId = Number(segments[5]);
    const result = archive.resolveLinkConflict(feedId, identityId, await readJson(request));
    if (result.status === 404) return notFound(response);
    return writeJson(response, result.status, result);
  }
  return notFound(response);
}

function readText(request) {
  return readBody(request).then((buffer) => buffer.toString("utf8"));
}

function readJson(request) {
  return readText(request).then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new TypeError("request body must be valid JSON");
    }
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("request body exceeds 5 MB"), { statusCode: 413 }));
        request.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
    request.once("aborted", () => reject(Object.assign(new Error("request body was interrupted"), { statusCode: 400 })));
  });
}

function notFound(response) {
  return writeJson(response, 404, { error: "not_found", message: "resource or route not found" });
}

function writeJson(response, status, value) {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

import crypto from "node:crypto";
