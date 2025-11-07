# Graph-Indexer Deployment Runbook

See main deployment runbook: `../graph-service/docs/DEPLOYMENT_RUNBOOK.md`

## Quick Start

```bash
# 1. Setup Neo4j constraints
make setup-neo4j

# 2. Backfill historical data
make backfill

# 3. Start indexer (local dev)
make start-indexer

# 4. Monitor status
make monitor-indexer
```

## Environment Variables

Required:
- `DATABASE_URL` - Postgres connection string
- `NEO4J_URI` - Neo4j bolt connection (e.g., `bolt+s://host:7687`)
- `NEO4J_USER` - Neo4j username
- `NEO4J_PASSWORD` - Neo4j password

Optional:
- `BATCH_SIZE` - Batch size for processing (default: 500)
- `POLL_INTERVAL_MS` - Poll interval in milliseconds (default: 2000)

## Railway Deployment

1. Create new Railway service: `graph-indexer`
2. Connect to GitHub repo
3. Set environment variables
4. Deploy (uses Dockerfile)

## Troubleshooting

### Indexer not processing

```bash
# Check outbox status
psql $DATABASE_URL -c "SELECT status, COUNT(*) FROM outbox_graph_events GROUP BY status;"

# Check for errors
psql $DATABASE_URL -c "SELECT id, event_type, error FROM outbox_graph_events WHERE status='failed' LIMIT 10;"
```

### Reset failed events

```sql
UPDATE outbox_graph_events
SET status='pending', attempts=0, error=null
WHERE status='failed';
```

### Check Neo4j connection

```bash
node scripts/setup-neo4j-constraints.js
```

If this fails, verify:
- `NEO4J_URI` format is correct
- Network/firewall allows connection
- Credentials are correct

