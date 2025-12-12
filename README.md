# Telegram Card Bot (Webhook) — Full project

This project implements a Telegram card game bot using:
- TypeScript + Telegraf (webhook mode)
- Express for webhook and cron endpoints
- PostgreSQL (pg)

Features:
- Free pack every 30 minutes (5 cards)
- Packs for purchase (2,3,10 cards)
- Card rarities (common/rare/epic/legendary) with value_per_hour
- Inventory listing
- Transfer cards between players (/trade)
- `/cron` endpoint to distribute hourly coins automatically (protected by CRON_SECRET)
- DB auto-creation at startup

## Environment variables (.env)
- BOT_TOKEN - Telegram bot token
- DATABASE_URL - Postgres connection string
- WEBHOOK_URL - public URL of your Render service (no trailing slash)
- CRON_SECRET - secret token for /cron

## Deploy on Render (Webhook + Cron)
1. Push repo to GitHub.
2. In Render create a new **Web Service**:
   - Environment: Node
   - Build command: `npm run build`
   - Start command: `npm start`
   - Add environment variables: BOT_TOKEN, DATABASE_URL, WEBHOOK_URL, CRON_SECRET
3. Create a **Cron Job** in Render that requests:
   `POST https://your-service.onrender.com/cron?secret=YOUR_CRON_SECRET`
   Schedule: every hour
4. After service is up, Render will call the webhook URL for updates; Telegram will send updates to your webhook automatically if BOT_TOKEN and WEBHOOK_URL are set correctly.

## Local testing
You can run locally with `npm run dev` and use a tunneling service (ngrok) to expose your local URL and set WEBHOOK_URL accordingly.
