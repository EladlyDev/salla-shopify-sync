import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '..', 'data', 'sync.db');

const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Creates all tables, indexes, and runs startup maintenance.
 * Safe to call multiple times — all statements use IF NOT EXISTS.
 */
export function initDb(): void {
  db.exec(`
    -- ── Product Mappings ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS product_mappings (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_product_id  INTEGER NOT NULL UNIQUE,
      salla_product_id    INTEGER,
      sku                 TEXT,
      sync_status         TEXT DEFAULT 'pending',
      last_error          TEXT,
      last_synced_at      TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    -- ── Variant Mappings ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS variant_mappings (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_mapping_id          INTEGER NOT NULL REFERENCES product_mappings(id) ON DELETE CASCADE,
      shopify_variant_id          INTEGER NOT NULL UNIQUE,
      shopify_inventory_item_id   INTEGER NOT NULL UNIQUE,
      salla_variant_id            INTEGER,
      sku                         TEXT,
      created_at                  TEXT DEFAULT (datetime('now'))
    );

    -- ── Inventory Sync ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS inventory_sync (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_mapping_id          INTEGER NOT NULL UNIQUE REFERENCES variant_mappings(id) ON DELETE CASCADE,
      shopify_inventory_item_id   INTEGER NOT NULL,
      shopify_location_id         INTEGER NOT NULL,
      last_known_shopify_qty      INTEGER,
      last_synced_to_salla_qty    INTEGER,
      unsynced_order_delta        INTEGER NOT NULL DEFAULT 0,
      last_sync_at                TEXT,
      updated_at                  TEXT DEFAULT (datetime('now'))
    );

    -- ── Inventory Adjustments ─────────────────────────────
    CREATE TABLE IF NOT EXISTS inventory_adjustments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_sync_id   INTEGER NOT NULL REFERENCES inventory_sync(id),
      salla_order_id      INTEGER NOT NULL,
      salla_order_item_id INTEGER,
      event_type          TEXT NOT NULL,
      delta               INTEGER NOT NULL,
      applied_to_shopify  INTEGER DEFAULT 0,
      error_message       TEXT,
      retry_count         INTEGER DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now')),
      applied_at          TEXT,
      UNIQUE(salla_order_id, salla_order_item_id, event_type)
    );

    -- ── Webhook Log ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS webhook_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      event_id    TEXT,
      payload     TEXT,
      processed   INTEGER DEFAULT 0,
      error       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- ── Indexes ───────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_inv_sync_shopify
      ON inventory_sync(shopify_inventory_item_id);

    CREATE INDEX IF NOT EXISTS idx_variant_salla
      ON variant_mappings(salla_variant_id);

    CREATE INDEX IF NOT EXISTS idx_adj_pending
      ON inventory_adjustments(applied_to_shopify)
      WHERE applied_to_shopify = 0;

    CREATE INDEX IF NOT EXISTS idx_webhook_dedup
      ON webhook_log(source, event_id);
  `);

  // Startup maintenance: purge webhook logs older than 7 days
  const deleted = db.prepare(`
    DELETE FROM webhook_log
    WHERE created_at < datetime('now', '-7 days')
  `).run();

  if (deleted.changes > 0) {
    console.log(`Cleaned up ${deleted.changes} webhook log entries older than 7 days`);
  }

  console.log('Database initialized successfully');
}

export default db;
