require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const Parser = require("rss-parser");
const { Telegraf } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ENGLISH_NEWS_CHAT_ID = process.env.ENGLISH_NEWS_CHAT_ID;
const ENGLISH_NEWS_TOPIC_ID = process.env.ENGLISH_NEWS_TOPIC_ID;
const CHINESE_NEWS_CHAT_ID = process.env.CHINESE_NEWS_CHAT_ID;
const CHINESE_NEWS_TOPIC_ID = process.env.CHINESE_NEWS_TOPIC_ID;

const NEWS_CHECK_INTERVAL_MS = Number(process.env.NEWS_CHECK_INTERVAL_MS || 10 * 60 * 1000);
const NEWS_MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 1);
const POST_TO_ENGLISH = String(process.env.POST_TO_ENGLISH || "true").toLowerCase() === "true";
const POST_TO_CHINESE = String(process.env.POST_TO_CHINESE || "false").toLowerCase() === "true";
let autoNewsEnabled = String(process.env.NEWS_AUTO_POST || "false").toLowerCase() === "true";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "UEExNewsBot/1.0"
  }
});

app.use(express.json());

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function isGroupChat(ctx) {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function getTopicId(ctx) {
  return ctx.message?.message_thread_id || null;
}

function buildTopicInfoMessage(ctx) {
  const chatId = ctx.chat?.id || "Unknown";
  const chatTitle = ctx.chat?.title || "Unknown";
  const chatType = ctx.chat?.type || "Unknown";
  const topicId = getTopicId(ctx);

  return `✅ Topic Info

Group: ${chatTitle}
Chat Type: ${chatType}
Chat ID: ${chatId}
Topic ID: ${topicId || "none"}

For English group with Crypto News Topic, use:

ENGLISH_NEWS_CHAT_ID=${chatId}
ENGLISH_NEWS_TOPIC_ID=${topicId || ""}

For Chinese group without Topic, use:

CHINESE_NEWS_CHAT_ID=${chatId}
CHINESE_NEWS_TOPIC_ID=`;
}

async function isAdminUser(ctx) {
  if (!isGroupChat(ctx)) return true;

  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "creator" || member.status === "administrator";
  } catch (error) {
    console.error("Check admin error:", error);
    return false;
  }
}

async function requireAdmin(ctx) {
  const isAdmin = await isAdminUser(ctx);

  if (!isAdmin) {
    await ctx.reply("Only admins can use this command.");
    return false;
  }

  return true;
}

function cleanHtml(input = "") {
  return String(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength = 420) {
  const cleaned = cleanHtml(text);

  if (cleaned.length <= maxLength) return cleaned;

  return `${cleaned.slice(0, maxLength).trim()}...`;
}

function parseDate(input) {
  if (!input) return null;

  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getItemLink(item) {
  return item.link || item.guid || item.id || null;
}

function getItemGuid(item) {
  return item.guid || item.id || item.link || null;
}

function buildFallbackHash(source, item) {
  const raw = [source.url, item.title, item.link, item.guid, item.pubDate].filter(Boolean).join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function isCryptoRelevant(item) {
  const text = `${item.title || ""} ${item.contentSnippet || ""} ${item.content || ""}`.toLowerCase();

  const keywords = [
    "bitcoin", "btc", "ethereum", "eth", "crypto", "cryptocurrency", "blockchain",
    "stablecoin", "usdt", "usdc", "solana", "sol", "xrp", "bnb", "doge",
    "exchange", "etf", "sec", "cftc", "defi", "wallet", "token", "altcoin",
    "trading", "market", "binance", "coinbase", "okx", "bybit", "trump"
  ];

  return keywords.some((keyword) => text.includes(keyword));
}

function buildEnglishNewsMessage(source, item) {
  const title = cleanHtml(item.title || "Untitled");
  const link = getItemLink(item);
  const summary = truncateText(item.contentSnippet || item.content || item.summary || title, 480);

  return `📰 Crypto News | ${source.name}

${title}

${summary}

Source: ${source.name}${link ? `\n${link}` : ""}`;
}

function buildChineseNewsMessage(source, item) {
  const title = cleanHtml(item.title || "Untitled");
  const link = getItemLink(item);
  const summary = truncateText(item.contentSnippet || item.content || item.summary || title, 480);

  return `📰 加密快讯｜${source.name}

${title}

${summary}

来源：${source.name}${link ? `\n${link}` : ""}`;
}

async function getActiveSources() {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const { data, error } = await supabase
    .from("news_sources")
    .select("*")
    .eq("is_active", true)
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Failed to load news sources: ${error.message}`);
  }

  return data || [];
}

async function hasNewsItem(source, item) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const link = getItemLink(item);
  const guid = getItemGuid(item);
  const fallbackHash = buildFallbackHash(source, item);

  let query = supabase.from("news_items").select("id").limit(1);

  if (link && guid) {
    query = query.or(`link.eq.${link},guid.eq.${guid},item_hash.eq.${fallbackHash}`);
  } else if (link) {
    query = query.or(`link.eq.${link},item_hash.eq.${fallbackHash}`);
  } else if (guid) {
    query = query.or(`guid.eq.${guid},item_hash.eq.${fallbackHash}`);
  } else {
    query = query.eq("item_hash", fallbackHash);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Check news item error:", error);
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

async function saveNewsItem(source, item, sentToEnglish, sentToChinese) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const title = cleanHtml(item.title || "Untitled");
  const link = getItemLink(item);
  const guid = getItemGuid(item);
  const contentSnippet = truncateText(item.contentSnippet || item.content || item.summary || "", 1000);
  const itemHash = buildFallbackHash(source, item);

  const payload = {
    source_name: source.name,
    source_url: source.url,
    title,
    link,
    guid,
    item_hash: itemHash,
    published_at: parseDate(item.isoDate || item.pubDate),
    content_snippet: contentSnippet,
    summary_en: buildEnglishNewsMessage(source, item),
    summary_cn: buildChineseNewsMessage(source, item),
    sent_to_en: sentToEnglish,
    sent_to_cn: sentToChinese,
    status: "sent"
  };

  const { error } = await supabase.from("news_items").insert(payload);

  if (error && error.code !== "23505") {
    throw new Error(`Failed to save news item: ${error.message}`);
  }
}

async function sendTelegramMessage(chatId, topicId, message) {
  if (!chatId) return false;

  const extra = {
    disable_web_page_preview: false
  };

  if (topicId) {
    extra.message_thread_id = Number(topicId);
  }

  await bot.telegram.sendMessage(chatId, message, extra);
  return true;
}

async function fetchCandidateNews(limit = NEWS_MAX_PER_RUN) {
  const sources = await getActiveSources();
  const candidates = [];

  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      const items = Array.isArray(feed.items) ? feed.items.slice(0, 10) : [];

      for (const item of items) {
        if (!item.title) continue;
        if (!isCryptoRelevant(item)) continue;

        const exists = await hasNewsItem(source, item);
        if (exists) continue;

        candidates.push({ source, item });
      }
    } catch (error) {
      console.error(`Fetch RSS error for ${source.name}:`, error.message);
    }
  }

  candidates.sort((a, b) => {
    const aTime = new Date(a.item.isoDate || a.item.pubDate || 0).getTime();
    const bTime = new Date(b.item.isoDate || b.item.pubDate || 0).getTime();
    return bTime - aTime;
  });

  return candidates.slice(0, limit);
}

async function processNewsRun({ limit = NEWS_MAX_PER_RUN, replyCtx = null } = {}) {
  if (!supabase) {
    const message = "Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.";
    if (replyCtx) await replyCtx.reply(message);
    return { sent: 0, message };
  }

  const candidates = await fetchCandidateNews(limit);

  if (candidates.length === 0) {
    const message = "No new crypto news found.";
    if (replyCtx) await replyCtx.reply(message);
    return { sent: 0, message };
  }

  let sentCount = 0;

  for (const { source, item } of candidates) {
    let sentToEnglish = false;
    let sentToChinese = false;

    if (POST_TO_ENGLISH && ENGLISH_NEWS_CHAT_ID) {
      const message = buildEnglishNewsMessage(source, item);
      sentToEnglish = await sendTelegramMessage(
        ENGLISH_NEWS_CHAT_ID,
        ENGLISH_NEWS_TOPIC_ID,
        message
      );
    }

    if (POST_TO_CHINESE && CHINESE_NEWS_CHAT_ID) {
      const message = buildChineseNewsMessage(source, item);
      sentToChinese = await sendTelegramMessage(
        CHINESE_NEWS_CHAT_ID,
        CHINESE_NEWS_TOPIC_ID,
        message
      );
    }

    await saveNewsItem(source, item, sentToEnglish, sentToChinese);

    if (sentToEnglish || sentToChinese) {
      sentCount += 1;
    }
  }

  const message = `News run completed. Sent ${sentCount} item(s).`;
  if (replyCtx) await replyCtx.reply(message);
  return { sent: sentCount, message };
}

function startScheduledNews() {
  setInterval(async () => {
    if (!autoNewsEnabled) return;

    try {
      await processNewsRun({ limit: NEWS_MAX_PER_RUN });
    } catch (error) {
      console.error("Scheduled news run error:", error);
    }
  }, NEWS_CHECK_INTERVAL_MS);
}

bot.start(async (ctx) => {
  await ctx.reply("UEEx News Bot is running.");
});

bot.command("ping", async (ctx) => {
  await ctx.reply("pong");
});

bot.command("topicid", async (ctx) => {
  if (!isGroupChat(ctx)) {
    return ctx.reply("Please use /topicid inside a Telegram group or topic.");
  }

  await ctx.reply(buildTopicInfoMessage(ctx));
});

bot.command("news_status", async (ctx) => {
  await ctx.reply(`📰 UEEx News Bot Status

Auto post: ${autoNewsEnabled ? "ON" : "OFF"}
Post to English: ${POST_TO_ENGLISH ? "ON" : "OFF"}
Post to Chinese: ${POST_TO_CHINESE ? "ON" : "OFF"}
Interval: ${NEWS_CHECK_INTERVAL_MS} ms
Max per run: ${NEWS_MAX_PER_RUN}
Supabase: ${supabase ? "configured" : "not configured"}
English chat: ${ENGLISH_NEWS_CHAT_ID || "not set"}
English topic: ${ENGLISH_NEWS_TOPIC_ID || "not set"}
Chinese chat: ${CHINESE_NEWS_CHAT_ID || "not set"}
Chinese topic: ${CHINESE_NEWS_TOPIC_ID || "not set"}`);
});

bot.command("news_now", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  try {
    await ctx.reply("Fetching latest crypto news...");
    await processNewsRun({ limit: 1, replyCtx: ctx });
  } catch (error) {
    console.error("Manual news run error:", error);
    await ctx.reply(`News run failed: ${error.message}`);
  }
});

bot.command("news_on", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  autoNewsEnabled = true;
  await ctx.reply("Auto news posting is now ON.");
});

bot.command("news_off", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  autoNewsEnabled = false;
  await ctx.reply("Auto news posting is now OFF.");
});

bot.command("news_sources", async (ctx) => {
  try {
    const sources = await getActiveSources();

    if (!sources.length) {
      return ctx.reply("No active news sources found.");
    }

    const lines = sources.map((source, index) => `${index + 1}. ${source.name}\n${source.url}`);
    await ctx.reply(`Active news sources:\n\n${lines.join("\n\n")}`);
  } catch (error) {
    await ctx.reply(`Failed to load sources: ${error.message}`);
  }
});

app.post("/telegram", async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => {
  res.send("UEEx News Bot is running.");
});

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  try {
    const botInfo = await bot.telegram.getMe();
    console.log(`Bot username: @${botInfo.username}`);

    if (WEBHOOK_URL) {
      const webhookUrl = `${WEBHOOK_URL.replace(/\/$/, "")}/telegram`;

      await bot.telegram.setWebhook(webhookUrl, {
        allowed_updates: ["message"]
      });

      console.log(`Webhook set to ${webhookUrl}`);
    } else {
      console.log("WEBHOOK_URL is not set. Webhook was not configured.");
    }

    startScheduledNews();
    console.log(`Auto news initial status: ${autoNewsEnabled ? "ON" : "OFF"}`);
  } catch (error) {
    console.error("Startup error:", error);
  }
});
