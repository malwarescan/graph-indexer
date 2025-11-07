/* jshint node: true, esversion: 11 */
require("dotenv").config();

const { Pool } = require("pg");
const { URL: NodeURL } = require("url");

const dbUrl = new NodeURL(process.env.DATABASE_URL || "");
const useInternal = dbUrl.hostname.endsWith("railway.internal");
const sslSetting = useInternal ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslSetting,
});

(async () => {
  console.log("[backfill] Starting backfill of historical triples and factlets...");

  const client = await pool.connect();
  try {
    // Backfill triples
    console.log("[backfill] Backfilling triples...");
    const tripleResult = await client.query(
      `INSERT INTO outbox_graph_events(event_type, payload, occurred_at)
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
       WHERE x IS NULL
       RETURNING id`
    );
    console.log(`[backfill] Inserted ${tripleResult.rowCount} triple events`);

    // Backfill factlets (croutons)
    console.log("[backfill] Backfilling factlets...");
    const factletResult = await client.query(
      `INSERT INTO outbox_graph_events(event_type, payload, occurred_at)
       SELECT
         'factlet.insert',
         jsonb_build_object(
           'id', c.id::text,
           'crouton_id', c.crouton_id,
           'source_url', c.source_url,
           'text', c.text,
           'corpus_id', c.corpus_id,
           'created_at', c.created_at
         ),
         c.created_at
       FROM croutons c
       LEFT JOIN LATERAL (
         SELECT 1 FROM outbox_graph_events e
         WHERE e.event_type='factlet.insert'
           AND e.payload->>'id' = c.id::text
         LIMIT 1
       ) x ON TRUE
       WHERE x IS NULL
       RETURNING id`
    );
    console.log(`[backfill] Inserted ${factletResult.rowCount} factlet events`);

    // Summary
    const summary = await client.query(
      `SELECT event_type, status, COUNT(*) as count
       FROM outbox_graph_events
       GROUP BY event_type, status
       ORDER BY event_type, status`
    );
    console.log("[backfill] Outbox summary:");
    summary.rows.forEach((row) => {
      console.log(`  ${row.event_type} [${row.status}]: ${row.count}`);
    });

    console.log("[backfill] Backfill complete. Start the indexer to process events.");
  } catch (e) {
    console.error("[backfill] Error:", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();

