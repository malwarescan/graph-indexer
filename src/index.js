/* jshint node: true, esversion: 11 */
require("dotenv").config();

const { Pool } = require("pg");
const neo4j = require("neo4j-driver");
const crypto = require("crypto");
const { URL: NodeURL } = require("url");

// ===== Config =====
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}
const dbUrl = new NodeURL(databaseUrl);
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

// ===== Process source_participation.insert event =====
async function processSourceParticipation(session, ev) {
  const { 
    crouton_id, 
    source_domain, 
    source_url, 
    ai_readable_source, 
    markdown_discovered, 
    discovery_method, 
    first_observed, 
    last_verified 
  } = ev.payload;
  
  if (!crouton_id || !source_domain || !source_url) {
    throw new Error("Missing required source participation fields");
  }

  const participationId = sha256(`${crouton_id}:${source_url}`);
  const domainId = sha256(source_domain);
  const now = first_observed || new Date().toISOString();

  // Create SourceDomain, Crouton, and SourceParticipation nodes with relationships
  const cypher = `
    MERGE (sd:SourceDomain {id: $domainId})
      ON CREATE SET sd.name = $sourceDomain, sd.created_at = $now
    MERGE (c:Crouton {id: $croutonId})
      ON CREATE SET c.created_at = $now
    MERGE (sp:SourceParticipation {id: $participationId})
      ON CREATE SET 
        sp.ai_readable_source = $aiReadableSource,
        sp.markdown_discovered = $markdownDiscovered,
        sp.discovery_method = $discoveryMethod,
        sp.first_observed = $firstObserved,
        sp.last_verified = $lastVerified,
        sp.created_at = $now
      ON MATCH SET 
        sp.last_verified = $lastVerified,
        sp.updated_at = $now
    MERGE (sd)-[:HAS_PARTICIPATION]->(sp)
    MERGE (sp)-[:TRACKS_CROUTON]->(c)
    RETURN id(sp) as participation_id, id(sd) as domain_id, id(c) as crouton_id
  `;

  await session.run(cypher, {
    participationId,
    domainId,
    croutonId: crouton_id,
    sourceDomain: source_domain,
    aiReadableSource: ai_readable_source || false,
    markdownDiscovered: markdown_discovered || false,
    discoveryMethod: discovery_method || 'unknown',
    firstObserved: first_observed || now,
    lastVerified: last_verified || now,
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
            } else if (ev.event_type === "source_participation.insert") {
              await processSourceParticipation(session, ev);
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

