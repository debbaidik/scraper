# 🏎️ Hot Wheels Stock Tracker — Crossword.in

A real-time web scraper that monitors [Crossword.in](https://www.crossword.in/) for new Hot Wheels products and sends you **email notifications** with product names and prices.

## Features

- **⚡ Fast polling** — Checks every 10 seconds (configurable)
- **📧 Gmail notifications** — Sends beautiful HTML emails with product images, names, prices & buy links
- **📊 Live dashboard** — Premium dark-themed web dashboard with real-time stats
- **💾 Persistent tracking** — Remembers seen products across restarts
- **🆕 Smart detection** — Only notifies on genuinely new products
- **🔒 Zero cost** — Uses Crossword.in's public Shopify API + free Gmail SMTP

## Quick Start

### 1. Set up Gmail App Password

1. Go to [Google App Passwords](https://myaccount.google.com/apppasswords)
2. Sign in with your Gmail account
3. Select **"Mail"** as the app
4. Click **Generate** and copy the 16-character password

> ⚠️ You need **2-Step Verification** enabled on your Google account first.

### 2. Configure

```bash
# Copy the example config
copy .env.example .env

# Edit .env with your credentials
notepad .env
```

Fill in:
```env
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
NOTIFY_EMAIL=your_email@gmail.com
SCRAPE_INTERVAL=10
PORT=3000
```

### 3. Run

```bash
npm start
```

### 4. Open Dashboard

Visit **http://localhost:3000** in your browser to see the live monitoring dashboard.

## How It Works

1. The scraper hits Crossword.in's Shopify search API every N seconds
2. Compares results against a local database of previously seen products
3. When new products are detected:
   - Sends an HTML email with product details
   - Shows a toast notification on the dashboard
   - Logs the discovery in the activity feed
4. All seen products are persisted in `data/seen_products.json`

## Project Structure

```
├── index.js            # Main scraper + Express server
├── dashboard.html      # Live monitoring dashboard
├── .env                # Your credentials (not committed)
├── .env.example        # Credential template
├── data/
│   ├── seen_products.json   # Persisted product database
│   └── scrape_log.json      # Activity log
└── package.json
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GMAIL_USER` | - | Your Gmail address |
| `GMAIL_APP_PASSWORD` | - | Gmail App Password (16 chars) |
| `NOTIFY_EMAIL` | - | Email to receive notifications |
| `SCRAPE_INTERVAL` | `10` | Seconds between checks |
| `PORT` | `3000` | Dashboard port |
