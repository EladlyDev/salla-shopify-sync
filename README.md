# 🔄 Salla ↔ Shopify Sync

Two-way product, inventory, and order synchronization between Shopify and Salla stores.

## Features

- **Product Sync** — Sync products, variants, images, and prices between platforms
- **Inventory Sync** — Real-time inventory updates via webhooks + scheduled reconciliation
- **Order Tracking** — Track Salla orders and adjust Shopify inventory accordingly
- **Automatic Token Refresh** — Salla OAuth tokens auto-refresh and persist to `.env`
- **Rate Limiting** — Built-in Bottleneck rate limiters for both APIs
- **Retry Logic** — Exponential backoff on 429/5xx/network errors
- **Telegram Alerts** — Real-time notifications for critical sync events
- **Dashboard** — Web UI to monitor sync status and troubleshoot errors
- **SQLite Database** — Lightweight mapping store with WAL mode for concurrent reads
- **BullMQ Queues** — Redis-backed job queues for reliable async processing

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Web Framework | Express + EJS |
| Database | SQLite (better-sqlite3) |
| Job Queue | BullMQ + ioredis |
| HTTP Client | Axios + axios-retry |
| Rate Limiting | Bottleneck |
| Scheduling | node-cron |
| Process Manager | PM2 |

## Prerequisites

- **Node.js** >= 18
- **Redis** (for BullMQ job queues)
- **Shopify** Partner account + development store with a custom app
- **Salla** Partner account + app with OAuth credentials

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials (see Configuration below)

# 3. Run in development
npm run dev

# 4. Build for production
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env` and fill in:

### Shopify
| Variable | Description |
|---|---|
| `SHOPIFY_SHOP` | Store domain (e.g. `store.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Admin API access token from custom app |
| `SHOPIFY_WEBHOOK_SECRET` | API secret key for webhook HMAC verification |
| `SHOPIFY_LOCATION_ID` | Primary location ID (number) |
| `SHOPIFY_API_VERSION` | API version (default: `2024-10`) |

### Salla
| Variable | Description |
|---|---|
| `SALLA_BASE_URL` | API base URL (default: `https://api.salla.dev/admin/v2`) |
| `SALLA_CLIENT_ID` | OAuth client ID from Salla Partners |
| `SALLA_CLIENT_SECRET` | OAuth client secret |
| `SALLA_ACCESS_TOKEN` | OAuth access token (auto-refreshed at runtime) |
| `SALLA_REFRESH_TOKEN` | OAuth refresh token (auto-refreshed at runtime) |
| `SALLA_WEBHOOK_SECRET` | Webhook signing secret |

### Infrastructure
| Variable | Description |
|---|---|
| `REDIS_URL` | Redis connection URL (default: `redis://localhost:6379`) |
| `TELEGRAM_BOT_TOKEN` | _(optional)_ Telegram bot token for alerts |
| `TELEGRAM_CHAT_ID` | _(optional)_ Telegram chat ID for alerts |
| `DASHBOARD_PASSWORD` | Dashboard login password (default: `admin123`) |

## Scripts

```bash
npm run dev        # Development mode with hot reload
npm run build      # Compile TypeScript to dist/
npm start          # Run production build
npm run full-sync  # Run a full product sync
```

## Production Deployment

```bash
# Build and start with PM2
npm run build
pm2 start ecosystem.config.js --env production

# Monitor
pm2 logs salla-shopify-sync
pm2 monit
```

> **Note:** Must run as a single instance (`instances: 1`) because the app uses in-memory mutexes for concurrency control.

## Project Structure

```
salla-shopify-sync/
├── src/
│   ├── config.ts              # Environment config with validation
│   ├── db.ts                  # SQLite database + schema
│   ├── server.ts              # Express server entrypoint
│   ├── clients/
│   │   ├── shopify.ts         # Shopify REST Admin API client
│   │   └── salla.ts           # Salla API client with token refresh
│   ├── webhooks/
│   │   ├── shopify.routes.ts  # Shopify webhook handlers
│   │   └── salla.routes.ts    # Salla webhook handlers
│   ├── sync/
│   │   ├── product-sync.ts    # Product sync logic
│   │   ├── inventory-sync.ts  # Inventory sync logic
│   │   ├── order-sync.ts      # Order sync logic
│   │   └── full-sync.ts       # Full sync orchestrator
│   ├── queues.ts              # BullMQ job queues
│   ├── cron.ts                # Scheduled jobs
│   ├── mapper.ts              # Data mapping between platforms
│   ├── telegram.ts            # Telegram alert utility
│   └── dashboard.ts           # Dashboard routes
├── views/
│   └── dashboard.ejs          # Dashboard template
├── data/                      # SQLite database files
├── .env.example               # Environment template
├── ecosystem.config.js        # PM2 config
├── package.json
└── tsconfig.json
```

## License

ISC
