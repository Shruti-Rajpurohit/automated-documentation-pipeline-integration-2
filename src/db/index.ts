import "@/lib/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

type DrizzleDb = ReturnType<typeof drizzle>;

const globalForDb = globalThis as typeof globalThis & {
  __doclinePool?: Pool;
  __doclineDb?: DrizzleDb;
};

function getPool(): Pool {
  if (globalForDb.__doclinePool) return globalForDb.__doclinePool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  // Idle-client errors must not take the process down.
  pool.on("error", (err) => {
    console.error("[docline] idle postgres client error:", err.message);
  });
  globalForDb.__doclinePool = pool;
  return pool;
}

function getDb(): DrizzleDb {
  globalForDb.__doclineDb ??= drizzle(getPool());
  return globalForDb.__doclineDb;
}

export const pool = new Proxy({} as Pool, {
  get(_target, property) {
    const instance = getPool();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export const db = new Proxy({} as DrizzleDb, {
  get(_target, property) {
    const instance = getDb();
    const value = Reflect.get(instance, property, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
