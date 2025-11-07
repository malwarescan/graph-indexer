/* jshint node: true, esversion: 11 */
require("dotenv").config();

const { Pool } = require("pg");
const neo4j = require("neo4j-driver");
const crypto = require("crypto");
const { URL: NodeURL } = require("url");

// ===== Config =====
const dbUrl = new NodeURL(process.env.DATABASE_URL || "");
const useInternal = dbUrl.hostname.endsWith("railway.internal");
const sslSetting = useInternal ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslSetting,
});

const driver = neo4j.driver(
  process.env.NEO4J_URI || "bolt://localhost:7687",
  neo4j.auth.basic(
    process.env.NEO4J_USER || "neo4j",
    process.env.NEO4J_PASSWORD || "password"
  )
);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "500", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

// ===== Helpers =====
function sha256(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

// ===== Claim batch from outbox =====
async function claimBatch(client, limit) {
  const { rows } = await client.query(
    `UPDATE outbox_graph_events
     SET status='processing'
     WHERE id IN (
       SELECT id FROM outbox_graph_events
       WHERE status='pending'
       ORDER BY occurred_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  return rows;
}

// ===== Process triple.insert event (Pattern A: Entities + ASSERTS edge) =====
async function processTriple(session, ev) {
  const { subject, predicate, object, evidence_crouton_id, created_at } = ev.payload;
  
  if (!subject || !predicate || !object) {
    throw new Error("Missing required triple fields");
  }

  const sid = sha256(subject);
  const oid = sha256(object);
  const now = created_at || new Date().toISOString();

  // Pattern A: upsert Entities + ASSERTS edge
  const cypher = `
    MERGE (s:Entity {id: $sid})
      ON CREATE SET s.name = $subject, s.created_at = $now
    MERGE (o:Entity {id: $oid})
      ON CREATE SET o.name = $object, o.created_at = $now
    MERGE (s)-[r:ASSERTS {predicate: $predicate}]->(o)
      ON CREATE SET r.created_at = $now
      ON MATCH SET r.updated_at = $now
    RETURN id(s) as s_id, id(o) as o_id
  `;

  await session.run(cypher, {
    sid,
    oid,
    subject,
    object,
    predicate,
    now,
  });
}

// ===== Process factlet.insert event =====
async function processFactlet(session, ev) {
  const { crouton_id, source_url, text, created_at } = ev.payload;
  
  if (!crouton_id || !source_url) {
    throw new Error("Missing required factlet fields");
  }

  const factletId = sha256(crouton_id);
  const pageId = sha256(source_url);
  const now = created_at || new Date().toISOString();

  // Create Factlet and WebPage nodes, link them
  const cypher = `
    MERGE (f:Factlet {id: $factletId})
      ON CREATE SET f.fact_id = $croutonId, f.claim = $text, f.created_at = $now
    MERGE (w:WebPage {id: $pageId})
      ON CREATE SET w.url = $sourceUrl, w.created_at = $now
    MERGE (f)-[:FROM_PAGE]->(w)
    RETURN id(f) as factlet_id, id(w) as page_id
  `;

  await session.run(cypher, {
    factletId,
    croutonId: crouton_id,
    text: text || "",
    pageId,
    sourceUrl: source_url,
    now,
  });
}

// ===== Main worker loop =====
async function worker() {
  console.log(`[indexer] Starting worker (batch_size=${BATCH_SIZE}, poll_interval=${POLL_INTERVAL_MS}ms)`);
  
  const client = await pool.connect();
  const session = driver.session();

  let processedTotal = 0;
  let failedTotal = 0;

  try {
    while (true) {
      try {
        const batch = await claimBatch(client, BATCH_SIZE);

        if (batch.length === 0) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        console.log(`[indexer] Processing batch of ${batch.length} events`);

        for (const ev of batch) {
          try {
            if (ev.event_type === "triple.insert") {
              await processTriple(session, ev);
            } else if (ev.event_type === "factlet.insert") {
              await processFactlet(session, ev);
            } else {
              console.warn(`[indexer] Unknown event_type: ${ev.event_type}`);
            }

            // Mark as done
            await client.query(
              `UPDATE outbox_graph_events SET status='done', attempts=attempts+1 WHERE id=$1`,
              [ev.id]
            );
            processedTotal++;
          } catch (e) {
            const errorMsg = String(e?.message || e);
            const newAttempts = ev.attempts + 1;
            const newStatus = newAttempts >= 5 ? "failed" : "pending";

            await client.query(
              `UPDATE outbox_graph_events 
               SET attempts=$1, status=$2, error=$3 
               WHERE id=$4`,
              [newAttempts, newStatus, errorMsg, ev.id]
            );

            failedTotal++;
            console.error(`[indexer] Error processing event ${ev.id}:`, errorMsg);
          }
        }

        // Log progress every batch
        if (processedTotal > 0 || failedTotal > 0) {
          console.log(
            `[indexer] Stats: processed=${processedTotal}, failed=${failedTotal}`
          );
        }
      } catch (e) {
        console.error("[indexer] Batch processing error:", e);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  } finally {
    await session.close();
    client.release();
    await driver.close();
    await pool.end();
  }
}

// ===== Graceful shutdown =====
process.on("SIGINT", async () => {
  console.log("\n[indexer] Shutting down gracefully...");
  await driver.close();
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[indexer] Shutting down gracefully...");
  await driver.close();
  await pool.end();
  process.exit(0);
});

// ===== Start worker =====
worker().catch((err) => {
  console.error("[indexer] Fatal error:", err);
  process.exit(1);
});

