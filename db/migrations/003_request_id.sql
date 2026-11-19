-- v3: grouped requests. Items checked together in one API request (one agency, one tier) share a request_id,
-- which is the custom_id sent to the Batches API. NULL for single-seat requests (custom_id is used).
ALTER TABLE run_items ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_items_request ON run_items(request_id);
