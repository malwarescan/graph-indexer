/* jshint node: true, esversion: 11 */
require("dotenv").config();

const neo4j = require("neo4j-driver");

const driver = neo4j.driver(
  process.env.NEO4J_URI || "bolt://localhost:7687",
  neo4j.auth.basic(
    process.env.NEO4J_USER || "neo4j",
    process.env.NEO4J_PASSWORD || "password"
  )
);

const constraints = [
  {
    name: "entity_id",
    cypher: "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;",
  },
  {
    name: "webpage_id",
    cypher: "CREATE CONSTRAINT webpage_id IF NOT EXISTS FOR (w:WebPage) REQUIRE w.id IS UNIQUE;",
  },
  {
    name: "factlet_id",
    cypher: "CREATE CONSTRAINT factlet_id IF NOT EXISTS FOR (f:Factlet) REQUIRE f.id IS UNIQUE;",
  },
];

(async () => {
  console.log("[setup] Setting up Neo4j constraints...");

  const session = driver.session();
  try {
    for (const constraint of constraints) {
      try {
        await session.run(constraint.cypher);
        console.log(`[setup] ✅ Created constraint: ${constraint.name}`);
      } catch (e) {
        if (e.message.includes("already exists") || e.message.includes("Equivalent constraint")) {
          console.log(`[setup] ⚠️  Constraint already exists: ${constraint.name}`);
        } else {
          console.error(`[setup] ❌ Error creating constraint ${constraint.name}:`, e.message);
        }
      }
    }
    console.log("[setup] Constraints setup complete.");
  } finally {
    await session.close();
    await driver.close();
  }
})();

