# Graph Indexer

Syncs triples and factlets from Postgres (graph-service) to Neo4j for downstream graph queries and analytics.

## Quick Start

1. **Set environment variables:**
   ```bash
   DATABASE_URL=postgresql://...
   NEO4J_URI=bolt+s://<host>:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=******
   BATCH_SIZE=500
   POLL_INTERVAL_MS=2000
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Setup Neo4j constraints:**
   ```bash
   node scripts/setup-neo4j-constraints.js
   ```

4. **Backfill historical data:**
   ```bash
   node scripts/backfill-outbox.js
   ```

5. **Start the indexer:**
   ```bash
   npm start
   ```

## Architecture

- **Source:** Postgres `outbox_graph_events` table (populated by triggers)
- **Target:** Neo4j property graph
- **Pattern:** Outbox pattern with idempotent MERGE operations

## Data Model

### Pattern A (Current Implementation)

- **Entities:** `(:Entity {id, name})`
- **Relationships:** `(:Entity)-[:ASSERTS {predicate}]->(:Entity)`
- **Factlets:** `(:Factlet {id, fact_id, claim})-[:FROM_PAGE]->(:WebPage {id, url})`

### Pattern B (Source Tracking - New)

- **Source Domains:** `(:SourceDomain {id, name})`
- **Source Participation:** `(:SourceParticipation {id, ai_readable_source, markdown_discovered, discovery_method, first_observed, last_verified})`
- **Relationships:** 
  - `(:SourceDomain)-[:HAS_PARTICIPATION]->(:SourceParticipation)`
  - `(:SourceParticipation)-[:TRACKS_CROUTON]->(:Crouton {id})`

### Event Types

- `triple.insert`: Entity relationships (Pattern A)
- `factlet.insert`: Factlet to webpage links (Pattern A)  
- `source_participation.insert`: AI-readable source tracking (Pattern B)

## Verification

```bash
# Check Postgres outbox
psql $DATABASE_URL -c "SELECT status, COUNT(*) FROM outbox_graph_events GROUP BY status"

# Check Neo4j entities
cypher-shell -u neo4j -p <password> "MATCH (e:Entity) RETURN count(e)"
```

See `docs/GRAPH_INDEXER.md` for full documentation.

