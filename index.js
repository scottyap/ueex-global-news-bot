require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

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
  } catch (error) {
    console.error("Startup error:", error);
  }
});
