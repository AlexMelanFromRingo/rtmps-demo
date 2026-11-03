-- Per-claim lease token: ownership of a running job is proven by the token
-- of *this* claim, not by the worker id (a worker may re-claim its own job
-- after a DB outage; the stale run must be fenced off).
ALTER TABLE transcode_jobs ADD COLUMN lease_id uuid;

-- A broadcast is bound to the ingest path it is published on, not to the
-- channel's *current* stream key: resetting the key mid-stream must not end
-- the running broadcast.
ALTER TABLE broadcasts ADD COLUMN ingest_path text;
UPDATE broadcasts b SET ingest_path = 'live/' || c.stream_key
  FROM channels c WHERE c.id = b.channel_id AND b.status <> 'ended';
CREATE INDEX broadcasts_active_path_idx ON broadcasts (ingest_path) WHERE status <> 'ended';
