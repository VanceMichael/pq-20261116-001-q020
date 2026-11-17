export class CaptureRepository {
  constructor(database) {
    this.database = database;
    this.findFingerprint = database.prepare("SELECT * FROM captures WHERE feed_id=? AND fingerprint=?");
    this.insertCapture = database.prepare(`INSERT INTO captures
      (feed_id, fingerprint, captured_at, accepted, candidate_count, normalized_count,
       rejected_count, duplicate_count, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.listCaptures = database.prepare(`SELECT * FROM captures WHERE feed_id=?
      ORDER BY capture_id DESC LIMIT ?`);
    this.latestAccepted = database.prepare(`SELECT capture_id, captured_at, normalized_count FROM captures
      WHERE feed_id=? AND accepted=1 ORDER BY capture_id DESC LIMIT 2`);
    this.setQuarantineCount = database.prepare("UPDATE captures SET quarantined_count=? WHERE capture_id=?");
  }

  findByFingerprint(feedId, fingerprint) {
    const row = this.findFingerprint.get(feedId, fingerprint);
    return row ? mapCapture(row) : null;
  }

  create({ feedId, fingerprint, capturedAt, accepted, candidateCount, normalizedCount,
    rejectedCount, duplicateCount, reason = null }) {
    const result = this.insertCapture.run(feedId, fingerprint, capturedAt, Number(accepted),
      candidateCount, normalizedCount, rejectedCount, duplicateCount, reason);
    return Number(result.lastInsertRowid);
  }

  recent(feedId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.listCaptures.all(feedId, safeLimit).map(mapCapture);
  }

  acceptedPair(feedId) {
    return this.latestAccepted.all(feedId).map(mapCapture);
  }

  setQuarantinedCount(captureId, count) {
    this.setQuarantineCount.run(count, captureId);
  }
}

function mapCapture(row) {
  return {
    captureId: row.capture_id,
    feedId: row.feed_id,
    fingerprint: row.fingerprint,
    capturedAt: row.captured_at,
    accepted: Boolean(row.accepted),
    candidateCount: row.candidate_count,
    normalizedCount: row.normalized_count,
    rejectedCount: row.rejected_count,
    duplicateCount: row.duplicate_count,
    quarantinedCount: row.quarantined_count ?? 0,
    reason: row.reason
  };
}
