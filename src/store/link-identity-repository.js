export class LinkIdentityRepository {
  constructor(database) {
    this.database = database;
    this.feedArticles = database.prepare(`SELECT article_id, canonical_url, title, published_at,
      first_seen_at, last_seen_at, seen_count, visibility, review_state, review_note, review_revision
      FROM articles WHERE feed_id=? ORDER BY article_id`);
    this.findIdentityByUrl = database.prepare("SELECT * FROM link_identities WHERE feed_id=? AND canonical_url=?");
    this.findIdentityById = database.prepare("SELECT * FROM link_identities WHERE identity_id=?");
    this.insertIdentity = database.prepare(`INSERT INTO link_identities
      (feed_id, canonical_url, status, created_at, resolved_at) VALUES (?, ?, ?, ?, NULL)`);
    this.listIdentities = database.prepare("SELECT * FROM link_identities WHERE feed_id=? ORDER BY identity_id");
    this.listMembers = database.prepare(`SELECT m.identity_id, m.article_id, m.member_url, m.role, m.linked_at,
      a.canonical_url, a.title, a.seen_count, a.visibility, a.review_state, a.review_note, a.review_revision,
      a.first_seen_at, a.last_seen_at
      FROM link_identity_members m JOIN articles a ON a.article_id=m.article_id
      WHERE m.identity_id=? ORDER BY m.role DESC, m.article_id`);
    this.memberByArticle = database.prepare("SELECT * FROM link_identity_members WHERE article_id=?");
    this.insertMember = database.prepare(`INSERT INTO link_identity_members
      (identity_id, article_id, member_url, role, linked_at) VALUES (?, ?, ?, ?, ?)`);
    this.updateMemberRole = database.prepare("UPDATE link_identity_members SET role=? WHERE identity_id=? AND article_id=?");
    this.markIdentityStatus = database.prepare("UPDATE link_identities SET status=?, resolved_at=? WHERE identity_id=?");
    this.insertEvent = database.prepare(`INSERT INTO link_rule_events
      (feed_id, event_type, detail_json, changed_at) VALUES (?, ?, ?, ?)`);
    this.listEvents = database.prepare(`SELECT event_id, feed_id, event_type, detail_json, changed_at
      FROM link_rule_events WHERE feed_id=? ORDER BY event_id DESC LIMIT ?`);
    this.insertQuarantine = database.prepare(`INSERT INTO quarantined_observations
      (feed_id, identity_id, capture_id, source_index, observed_url, canonical_url, title,
       published_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.listQuarantineByIdentity = database.prepare(`SELECT * FROM quarantined_observations
      WHERE identity_id=? ORDER BY observation_id`);
    this.countQuarantineByCapture = database.prepare("SELECT COUNT(*) AS count FROM quarantined_observations WHERE capture_id=?");
  }

  articlesFor(feedId) {
    return this.feedArticles.all(feedId).map(mapStoredArticle);
  }

  identityForUrl(feedId, canonicalUrl) {
    const row = this.findIdentityByUrl.get(feedId, canonicalUrl);
    return row ? mapIdentity(row) : null;
  }

  identity(identityId) {
    const row = this.findIdentityById.get(identityId);
    return row ? mapIdentity(row) : null;
  }

  identitiesFor(feedId) {
    return this.listIdentities.all(feedId).map(mapIdentity);
  }

  createIdentity(feedId, canonicalUrl, status, now) {
    const result = this.insertIdentity.run(feedId, canonicalUrl, status, now);
    return Number(result.lastInsertRowid);
  }

  members(identityId) {
    return this.listMembers.all(identityId).map(mapMember);
  }

  memberForArticle(articleId) {
    const row = this.memberByArticle.get(articleId);
    return row ? { identityId: row.identity_id, articleId: row.article_id, memberUrl: row.member_url, role: row.role, linkedAt: row.linked_at } : null;
  }

  addMember(identityId, articleId, memberUrl, role, now) {
    this.insertMember.run(identityId, articleId, memberUrl, role, now);
  }

  setMemberRole(identityId, articleId, role) {
    this.updateMemberRole.run(role, identityId, articleId);
  }

  setStatus(identityId, status, now) {
    this.markIdentityStatus.run(status, now, identityId);
  }

  recordEvent(feedId, eventType, detail, now) {
    this.insertEvent.run(feedId, eventType, JSON.stringify(detail), now);
  }

  events(feedId, limit = 50) {
    return this.listEvents.all(feedId, Math.max(1, Math.min(200, Number(limit) || 50))).map((row) => ({
      eventId: row.event_id,
      feedId: row.feed_id,
      eventType: row.event_type,
      detail: JSON.parse(row.detail_json),
      changedAt: row.changed_at
    }));
  }

  quarantineObservation(entry) {
    this.insertQuarantine.run(entry.feedId, entry.identityId, entry.captureId, entry.sourceIndex,
      entry.observedUrl, entry.canonicalUrl, entry.title, entry.publishedAt ?? null, entry.observedAt);
  }

  quarantineForIdentity(identityId) {
    return this.listQuarantineByIdentity.all(identityId).map(mapQuarantine);
  }

  quarantineCountForCapture(captureId) {
    return this.countQuarantineByCapture.get(captureId).count;
  }
}

function mapIdentity(row) {
  return {
    identityId: row.identity_id,
    feedId: row.feed_id,
    canonicalUrl: row.canonical_url,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null
  };
}

function mapMember(row) {
  return {
    identityId: row.identity_id,
    articleId: row.article_id,
    memberUrl: row.member_url,
    role: row.role,
    linkedAt: row.linked_at,
    canonicalUrl: row.canonical_url,
    title: row.title,
    seenCount: row.seen_count,
    visibility: row.visibility,
    reviewState: row.review_state,
    reviewNote: row.review_note,
    reviewRevision: row.review_revision,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function mapStoredArticle(row) {
  return {
    articleId: row.article_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    visibility: row.visibility,
    reviewState: row.review_state,
    reviewNote: row.review_note,
    reviewRevision: row.review_revision
  };
}

function mapQuarantine(row) {
  return {
    observationId: row.observation_id,
    feedId: row.feed_id,
    identityId: row.identity_id,
    captureId: row.capture_id,
    sourceIndex: row.source_index,
    observedUrl: row.observed_url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    publishedAt: row.published_at,
    observedAt: row.observed_at
  };
}
