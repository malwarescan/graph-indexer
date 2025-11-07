# Graph Indexer Roadmap (Postgres → Neo4j)

## 0. Goal

Continuously mirror triples (and supporting entities) from graph-service (Postgres) into Neo4j, so downstream apps (exploration, analytics, embeddings) can query a native property graph.

---

## 1. High-level Architecture

- **Source of truth:** Postgres tables (pages, factlets, triples)
- **Change capture:** Postgres outbox table + triggers (no Kafka)
- **Indexer worker:** Node.js service (`indexer/`) consuming outbox rows → writes idempotent Cypher to Neo4j
- **Backfill:** One-off batch to seed historical data, then switch to real-time
- **Observability:** per-row status, retries, dead-letter queue (DLQ)

```
Postgres (graph-service)
  └─ tables: pages, factlets, triples
  └─ outbox_graph_events
         ↑ triggers on INSERT (and optional UPDATE)

Indexer (Node.js)
  └─ poll/batch read outbox → Neo4j (bolt+s)
  └─ mark processed / retries / DLQ

Neo4j
  └─ (:Entity {id}), (:Fact {id}), (:WebPage {id})
  └─ [:ASSERTS], [:EVIDENCED_BY], [:MENTIONS], [:FROM_PAGE]
```

---

## 2. Data Model Mapping

### Nodes

- **Entity:** `{ id: sha256(subject), name: subject }`
- **Predicate:** model as relationship type (preferred), fallback to `:Predicate` node if non-ASCII or too many variants
- **Fact** (optional but useful): `{ id: sha256(s|p|o|evidence_factlet_id), s, p, o, created_at }`
- **WebPage:** `{ id: sha256(url), url, title }`
- **Factlet:** `{ id: sha256(fact_id), fact_id, claim, created_at }`

### Relationships

- `(:Entity)-[:ASSERTS {predicate, created_at}]->(:Entity)`
- `(:Fact)-[:EVIDENCED_BY]->(:Factlet)`
- `(:Factlet)-[:FROM_PAGE]->(:WebPage)`
- `(:WebPage)-[:MENTIONS]->(:Entity)` (optional enrichment)
- `(:Fact)-[:SUBJECT]->(:Entity)` / `(:Fact)-[:OBJECT]->(:Entity)` (if you keep Fact nodes)

### Pattern Selection

**Pattern A (simple, fast):** Entities + ASSERTS edge with predicate as property.

**Pattern B (richer):** Add `:Fact` as first-class node to hang evidence, provenance, scores.

**Recommendation:** Start with Pattern A for speed, add `:Fact` later.

---

## 3. Neo4j Constraints (Cypher)

```cypher
CREATE CONSTRAINT entity_id IF NOT EXISTS
FOR (e:Entity) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT webpage_id IF NOT EXISTS
FOR (w:WebPage) REQUIRE w.id IS UNIQUE;

CREATE CONSTRAINT factlet_id IF NOT EXISTS
FOR (f:Factlet) REQUIRE f.id IS UNIQUE;

CREATE CONSTRAINT fact_id IF NOT EXISTS
FOR (f:Fact) REQUIRE f.id IS UNIQUE;  // if using Pattern B
```

**Setup script:** `scripts/setup-neo4j-constraints.js`

---

## 4. Postgres Outbox (DDL + Triggers)

### Outbox Table

```sql
CREATE TABLE IF NOT EXISTS outbox_graph_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL, -- 'triple.insert', 'factlet.insert', etc.
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_graph_events (status, occurred_at);
```

**Migration:** `graph-service/migrations/008_outbox.sql`

### Triggers

Triggers automatically insert events into `outbox_graph_events` when triples or factlets are inserted.

---

## 5. Indexer Service

### Environment Variables

```
DATABASE_URL=postgresql://...
NEO4J_URI=bolt+s://<host>:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=******
BATCH_SIZE=500
POLL_INTERVAL_MS=2000
```

### Worker Logic

1. Claim batch of pending events from outbox (with row-level locking)
2. Process each event:
   - `triple.insert` → Create/merge Entity nodes and ASSERTS relationship
   - `factlet.insert` → Create/merge Factlet and WebPage nodes
3. Mark events as `done` or `failed` (with retry logic)
4. Repeat

**Implementation:** `src/index.js`

---

## 6. Backfill Job (One-off)

### Approach

Stream triples ordered by `created_at`, emit synthetic `triple.insert` records into `outbox_graph_events`.

### SQL to Stage Backfill Events

```sql
INSERT INTO outbox_graph_events(event_type, payload, occurred_at)
SELECT
  'triple.insert',
  jsonb_build_object(
    'id', t.id::text,
    'subject', t.subject,
    'predicate', t.predicate,
    'object', t.object,
    'evidence_crouton_id', t.evidence_crouton_id,
    'created_at', t.created_at
  ),
  t.created_at
FROM triples t
LEFT JOIN LATERAL (
  SELECT 1 FROM outbox_graph_events e
  WHERE e.event_type='triple.insert'
    AND e.payload->>'id' = t.id::text
  LIMIT 1
) x ON TRUE
WHERE x IS NULL;
```

**Script:** `scripts/backfill-outbox.js`

Run the indexer; it will drain the outbox.

---

## 7. Idempotency & Determinism

- **Deterministic IDs** via SHA-256 over canonical strings:
  - `entity.id = sha256(name)`
  - `fact.id = sha256(subject+'|'+predicate+'|'+object+'|'+evidence_factlet_id)`
  - `webpage.id = sha256(url)`
  - `factlet.id = sha256(fact_id)`
- **Cypher MERGE** everywhere. No duplicates.

---

## 8. Deployment

### New Service: graph-indexer on Railway (Node 20+)

### Secrets

- `DATABASE_URL`
- `NEO4J_URI`
- `NEO4J_USER`
- `NEO4J_PASSWORD`
- `BATCH_SIZE` (optional, default: 500)
- `POLL_INTERVAL_MS` (optional, default: 2000)

### Init Checklist

1. Apply Neo4j constraints (Section 3) → `node scripts/setup-neo4j-constraints.js`
2. Apply outbox DDL + triggers (Section 4) → Run `graph-service/migrations/008_outbox.sql`
3. Seed backfill (Section 6) → `node scripts/backfill-outbox.js`
4. Start indexer and monitor logs → `npm start`
5. Verify counts (Section 9)

---

## 9. Verification (Smoke Tests)

### Postgres

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM triples"
psql $DATABASE_URL -c "SELECT status, count(*) FROM outbox_graph_events GROUP BY 1"
```

### Neo4j (Cypher)

```cypher
// Count entities
MATCH (e:Entity) RETURN count(e);

// Sample assertion
MATCH (s:Entity)-[r:ASSERTS]->(o:Entity)
RETURN s.name, r.predicate, o.name
LIMIT 10;

// If using Fact nodes
MATCH (f:Fact)-[:EVIDENCED_BY]->(:Factlet) RETURN count(f);
```

### End-to-end

Insert a new triple in Postgres → confirm a new ASSERTS edge appears in Neo4j within a few seconds.

---

## 10. Observability & Failure Handling

- `outbox_graph_events.status`: `pending|processing|done|failed`
- Retry up to 5× with exponential backoff (simple: sleep between worker loops)
- Add a small `/metrics` (Prometheus) in indexer later:
  - `processed_total`, `failed_total`, `lag_seconds` (now - oldest pending occurred_at)

### Monitoring Queries

```sql
-- Check processing lag
SELECT 
  status, 
  COUNT(*) as count,
  MIN(occurred_at) as oldest,
  EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) as lag_seconds
FROM outbox_graph_events
GROUP BY status;

-- Check failed events
SELECT id, event_type, error, attempts, occurred_at
FROM outbox_graph_events
WHERE status = 'failed'
ORDER BY occurred_at DESC
LIMIT 10;
```

---

## 11. Phased Rollout

### Phase 1 (1–2 days)

- ✅ Add outbox + triggers
- ✅ Ship indexer (Pattern A mapping)
- ✅ Backfill + verify

### Phase 2 (next sprint)

- Add Fact nodes and provenance edges
- Add WebPage/Factlet linkage (already implemented)
- Basic metrics endpoint

### Phase 3 (later)

- Embeddings + vector store
- Predicate normalization (ontology)
- Query API for Neo4j-backed features

---

## 12. Minimal Deliverables

- ✅ `graph-service/migrations/008_outbox.sql` (table + triggers)
- ✅ `graph-indexer/` (Node service with Dockerfile + README)
- ✅ `docs/GRAPH_INDEXER.md` (this plan + runbook)
- ✅ `scripts/backfill-outbox.js` (the seed script)

---

## Troubleshooting

### Indexer not processing events

1. Check outbox has pending events: `SELECT COUNT(*) FROM outbox_graph_events WHERE status='pending'`
2. Check indexer logs for errors
3. Verify Neo4j connection: `node scripts/setup-neo4j-constraints.js`

### Events stuck in processing

Events marked as `processing` but indexer restarted. Reset them:

```sql
UPDATE outbox_graph_events 
SET status='pending' 
WHERE status='processing' 
AND occurred_at < NOW() - INTERVAL '5 minutes';
```

### Neo4j connection errors

- Verify `NEO4J_URI` format: `bolt+s://host:7687` or `bolt://host:7687`
- Check firewall/network access
- Verify credentials

---

## Performance Tuning

- **BATCH_SIZE:** Increase for higher throughput (default: 500)
- **POLL_INTERVAL_MS:** Decrease for lower latency (default: 2000ms)
- **Neo4j batch writes:** Consider batching multiple MERGE operations in a single transaction for better performance

---

## Future Enhancements

- Pattern B: Add `:Fact` nodes for richer provenance
- Real-time webhooks instead of polling
- Metrics endpoint (`/metrics` Prometheus format)
- Dead-letter queue (DLQ) for permanently failed events
- Predicate normalization and ontology mapping

