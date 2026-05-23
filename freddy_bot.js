/**
 * Freddy Bot — Friendly AI Agent for Telegram
 * Powered by Groq + node-telegram-bot-api + Express (for Render keep-alive)
 *
 * Setup on Render:
 *   1. New Web Service → connect your GitHub repo with this file
 *   2. Build Command:  npm install
 *   3. Start Command:  node freddy_bot.js
 *   4. Add Environment Variables:
 *        TELEGRAM_TOKEN = your_bot_token
 *        GROQ_API_KEY   = your_groq_key
 *        PORT           = 3000  (Render sets this automatically)
 *
 * Then add your Render URL to UptimeRobot to ping every 5 minutes.
 */

const TelegramBot = require("node-telegram-bot-api");
const Groq        = require("groq-sdk");
const express     = require("express");

// ── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const PORT           = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.error("❌  Set TELEGRAM_TOKEN and GROQ_API_KEY env vars.");
  process.exit(1);
}

// ── Express keep-alive server ────────────────────────────────────────────────
const app = express();

app.get("/", (req, res) => {
  res.send("🤖 Freddy is alive and running!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: "Freddy", uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// ── Telegram + Groq ──────────────────────────────────────────────────────────
const bot  = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Freddy's Persona ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Freddy, a friendly and helpful AI agent on Telegram.

Your personality:
- Warm, cheerful, and approachable — like a knowledgeable best friend
- You speak casually but clearly. No stiff corporate tone.
- You use light humor when appropriate but never overdo it
- You are proactive: if the user seems stuck, offer the next step yourself
- You can help with tasks, answer questions, write, code, plan, brainstorm — you're a capable agent
- Keep replies concise unless the user clearly wants detail
- Use emojis sparingly (1–2 max per message, only when natural)
- Never say "As an AI..." or "I'm just a language model..." — you ARE Freddy.`;

// ── Per-user conversation memory ─────────────────────────────────────────────
const conversations = {};

function getHistory(userId) {
  if (!conversations[userId]) conversations[userId] = [];
  return conversations[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > 20) history.splice(0, history.length - 20);
}

// ── Thinking animation ────────────────────────────────────────────────────────
const THINKING_FRAMES = [
  "✦ Thinking",
  "✦ Thinking.",
  "✦ Thinking..",
  "✦ Thinking...",
];

async function sendThinkingMessage(chatId) {
  const msg = await bot.sendMessage(chatId, THINKING_FRAMES[0]);
  return msg.message_id;
}

function animateThinking(chatId, messageId, stopSignal) {
  let frame = 0;
  const interval = setInterval(async () => {
    if (stopSignal.stopped) {
      clearInterval(interval);
      return;
    }
    frame = (frame + 1) % THINKING_FRAMES.length;
    try {
      await bot.editMessageText(THINKING_FRAMES[frame], {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (_) {}
  }, 1000);
  return interval;
}

// ── Message handler ───────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text?.trim();

  if (!text) return;

  if (text === "/start") {
    const firstName = msg.from.first_name || "there";
    await bot.sendMessage(
      chatId,
      `Hey ${firstName}! 👋 I'm Freddy, your friendly AI agent.\n\nAsk me anything — I'm here to help!`
    );
    return;
  }

  if (text === "/reset") {
    conversations[userId] = [];
    await bot.sendMessage(chatId, "Memory cleared! Fresh start 🧹");
    return;
  }

  addToHistory(userId, "user", text);

  await bot.sendChatAction(chatId, "typing");
  const thinkingMsgId = await sendThinkingMessage(chatId);
  const stopSignal    = { stopped: false };
  animateThinking(chatId, thinkingMsgId, stopSignal);

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...getHistory(userId),
      ],
      temperature: 0.75,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content?.trim()
      || "Hmm, I didn't get a response. Try again?";

    stopSignal.stopped = true;

    await bot.editMessageText(reply, {
      chat_id: chatId,
      message_id: thinkingMsgId,
      parse_mode: "Markdown",
    });

    addToHistory(userId, "assistant", reply);

  } catch (err) {
    stopSignal.stopped = true;
    console.error("Error:", err.message);
    try {
      await bot.editMessageText("⚠️ Something went wrong. Try again!", {
        chat_id: chatId,
        message_id: thinkingMsgId,
      });
    } catch (_) {}
  }
});

console.log("🤖 Freddy is online!");
