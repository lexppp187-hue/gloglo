import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // example: https://your-service.onrender.com
const CRON_SECRET = process.env.CRON_SECRET || 'secret';

if (!BOT_TOKEN || !DATABASE_URL || !WEBHOOK_URL) {
  console.error('Missing required env vars. Set BOT_TOKEN, DATABASE_URL, WEBHOOK_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// rarities and values
const RARITIES: { [k: string]: number } = {
  common: 1,
  rare: 3,
  epic: 7,
  legendary: 15
};

const PACKS: any = {
  pack_free: { cards: 5, cost: 0 },
  pack_2: { cards: 2, cost: 50 },
  pack_3: { cards: 3, cost: 100 },
  pack_10: { cards: 10, cost: 250 }
};

function randChoice<T>(arr: T[], weights?: number[]) {
  if (!weights) return arr[Math.floor(Math.random() * arr.length)];
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < arr.length; i++) {
    if (r < weights[i]) return arr[i];
    r -= weights[i];
  }
  return arr[arr.length - 1];
}

function generateCard() {
  const rarity = randChoice(Object.keys(RARITIES), [70, 20, 8, 2]);
  return { rarity, value_per_hour: RARITIES[rarity] };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      coins BIGINT DEFAULT 0,
      last_pack TIMESTAMPTZ DEFAULT '1970-01-01 00:00:00+00',
      last_claim TIMESTAMPTZ DEFAULT '1970-01-01 00:00:00+00'
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      rarity TEXT NOT NULL,
      value_per_hour INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function ensureUser(userId: number) {
  await pool.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

async function addCards(userId: number, cards: { rarity: string; value_per_hour: number }[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of cards) {
      await client.query('INSERT INTO inventory (user_id, rarity, value_per_hour) VALUES ($1,$2,$3)', [userId, c.rarity, c.value_per_hour]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getInventory(userId: number) {
  const res = await pool.query('SELECT id, rarity, value_per_hour, created_at FROM inventory WHERE user_id=$1 ORDER BY id', [userId]);
  return res.rows;
}

async function getCoins(userId: number) {
  const res = await pool.query('SELECT coins FROM users WHERE user_id=$1', [userId]);
  return res.rows[0] ? Number(res.rows[0].coins) : 0;
}

async function changeCoins(userId: number, delta: number) {
  await pool.query('UPDATE users SET coins = coins + $1 WHERE user_id=$2', [delta, userId]);
}

async function getLastPack(userId: number) {
  const res = await pool.query('SELECT last_pack FROM users WHERE user_id=$1', [userId]);
  return res.rows[0] ? res.rows[0].last_pack : null;
}

async function setLastPack(userId: number, ts: Date) {
  await pool.query('UPDATE users SET last_pack=$1 WHERE user_id=$2', [ts.toISOString(), userId]);
}

async function transferCard(fromId: number, toId: number, cardId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT user_id FROM inventory WHERE id=$1 FOR UPDATE', [cardId]);
    if (!row.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Card not found' };
    }
    if (Number(row.rows[0].user_id) !== fromId) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'You are not owner of this card' };
    }
    await client.query('UPDATE inventory SET user_id=$1 WHERE id=$2', [toId, cardId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function calcAccruedCoinsLazy(userId: number) {
  // If using cron, we distribute hourly. Lazy calculation can still be used to approximate between cron runs.
  const lastClaimRes = await pool.query('SELECT last_claim FROM users WHERE user_id=$1', [userId]);
  let lastClaim = lastClaimRes.rows[0] ? new Date(lastClaimRes.rows[0].last_claim) : new Date(0);
  const now = new Date();
  const seconds = (now.getTime() - lastClaim.getTime()) / 1000;
  if (seconds <= 0) return 0;
  const incomeRes = await pool.query('SELECT COALESCE(SUM(value_per_hour),0) AS s FROM inventory WHERE user_id=$1', [userId]);
  const incomePerHour = Number(incomeRes.rows[0].s || 0);
  const coins = Math.floor(incomePerHour * (seconds / 3600));
  return coins;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Open free pack', 'free_pack')],
    [Markup.button.callback('Shop', 'shop')],
    [Markup.button.callback('Inventory', 'inventory')],
    [Markup.button.callback('Claim (lazy)', 'claim')],
  ]);
}

function shopMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Pack x2 — 50', 'buy_pack_2')],
    [Markup.button.callback('Pack x3 — 100', 'buy_pack_3')],
    [Markup.button.callback('Pack x10 — 250', 'buy_pack_10')],
    [Markup.button.callback('Back', 'back')],
  ]);
}

const bot = new Telegraf(BOT_TOKEN);

// Handlers
bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUser(userId);
  await ctx.reply('Welcome! Use inline menu.', { reply_markup: mainMenu() as any });
});

bot.action('free_pack', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUser(userId);
  const last = await getLastPack(userId);
  const now = new Date();
  const cooldownMs = 30 * 60 * 1000;
  if (last && (now.getTime() - new Date(last).getTime()) < cooldownMs) {
    const remainingMs = cooldownMs - (now.getTime() - new Date(last).getTime());
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    return ctx.reply(`Free pack available in ${mins}m ${secs}s`);
  }
  const cards = Array.from({ length: PACKS.pack_free.cards }).map(() => generateCard());
  await addCards(ctx.from!.id, cards);
  await setLastPack(ctx.from!.id, new Date());
  return ctx.reply('You opened a free pack:\\n' + cards.map(c => `${c.rarity} (+${c.value_per_hour}/h)`).join('\\n'));
});

bot.action('shop', async (ctx) => ctx.reply('Shop:', { reply_markup: shopMenu() as any }));

bot.action(/buy_pack_\\d+/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUser(userId);
  const key = (ctx.update.callback_query as any).data.replace('buy_', '');
  const info = PACKS[key];
  if (!info) return ctx.reply('Unknown pack');
  const coins = await getCoins(userId);
  if (coins < info.cost) return ctx.reply('Not enough coins');
  await changeCoins(userId, -info.cost);
  const cards = Array.from({ length: info.cards }).map(() => generateCard());
  await addCards(userId, cards);
  return ctx.reply('You bought a pack:\\n' + cards.map(c => `${c.rarity} (+${c.value_per_hour}/h)`).join('\\n'));
});

bot.action('inventory', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUser(userId);
  const rows = await getInventory(userId);
  if (!rows.length) return ctx.reply('Inventory empty');
  const lines = rows.map((r: any) => `ID:${r.id} - ${r.rarity} (+${r.value_per_hour}/h) - ${r.created_at}`);
  const incomeRes = await pool.query('SELECT COALESCE(SUM(value_per_hour),0) AS s FROM inventory WHERE user_id=$1', [userId]);
  const income = Number(incomeRes.rows[0].s || 0);
  const coins = await getCoins(userId);
  return ctx.reply('Inventory:\\n' + lines.join('\\n') + `\\n\\nIncome: ${income}/h\\nBalance: ${coins}`);
});

bot.action('claim', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ensureUser(userId);
  const coins = await calcAccruedCoinsLazy(userId);
  if (coins <= 0) return ctx.reply('No coins to claim');
  await changeCoins(userId, coins);
  await pool.query('UPDATE users SET last_claim=$1 WHERE user_id=$2', [new Date().toISOString(), userId]);
  const newBal = await getCoins(userId);
  return ctx.reply(`You claimed ${coins} coins. New balance: ${newBal}`);
});

bot.action('back', async (ctx) => ctx.reply('Back', { reply_markup: mainMenu() as any }));

bot.on('text', async (ctx) => {
  // simple text handler for commands like /trade and /balance
  const text = ctx.message?.text || '';
  if (text.startsWith('/trade')) {
    const parts = text.split(/\s+/);
    if (parts.length !== 3) return ctx.reply('Usage: /trade <target_user_id> <card_id>');
    const target = Number(parts[1]);
    const cardId = Number(parts[2]);
    await ensureUser(ctx.from!.id);
    await ensureUser(target);
    const res = await transferCard(ctx.from!.id, target, cardId);
    if (!res.ok) return ctx.reply('Trade failed: ' + (res.error || 'unknown'));
    return ctx.reply(`Card ${cardId} sent to ${target}`);
  }
  if (text === '/balance') {
    await ensureUser(ctx.from!.id);
    const coins = await getCoins(ctx.from!.id);
    return ctx.reply(`Balance: ${coins}`);
  }
});

// Express app for webhook and cron
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  // deliver update to telegraf
  bot.handleUpdate(req.body).then(() => res.sendStatus(200)).catch((err) => {
    console.error('handleUpdate error', err);
    res.sendStatus(500);
  });
});

// Cron endpoint - POST only and protected by CRON_SECRET query param
app.post('/cron', async (req, res) => {
  const secret = req.query.secret as string;
  if (!secret || secret !== CRON_SECRET) return res.status(401).send('Unauthorized');
  try {
    // Distribute hourly income to users in single query
    await pool.query(`
      UPDATE users u SET coins = u.coins + COALESCE(inv.sum,0)
      FROM (
        SELECT user_id, SUM(value_per_hour) AS sum FROM inventory GROUP BY user_id
      ) inv
      WHERE u.user_id = inv.user_id;
    `);
    return res.send('ok');
  } catch (e) {
    console.error('cron error', e);
    return res.status(500).send('error');
  }
});

// Startup
const PORT = Number(process.env.PORT || 10000);
(async () => {
  try {
    await initDb();
    // set webhook
    const webhookUrl = WEBHOOK_URL.replace(/\/$/, '') + '/webhook';
    await bot.telegram.setWebhook(webhookUrl);
    // start express
    app.listen(PORT, () => {
      console.log('Server started on port', PORT);
      console.log('Webhook URL set to', webhookUrl);
    });
  } catch (e) {
    console.error('Startup error', e);
    process.exit(1);
  }
})();
