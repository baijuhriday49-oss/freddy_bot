/**
 * Freddy Bot v2 — Friendly AI Agent for Telegram
 * Features: Web Search, Voice TTS (Groq Orpheus), Link Summarizer, File Creation
 *
 * npm install node-telegram-bot-api groq-sdk express axios cheerio
 *
 * Env vars: TELEGRAM_TOKEN, GROQ_API_KEY
 */

const TelegramBot = require("node-telegram-bot-api");
const Groq        = require("groq-sdk");
const express     = require("express");
const axios       = require("axios");
const cheerio     = require("cheerio");
const fs          = require("fs");
const path        = require("path");
const os          = require("os");

// ── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const PORT           = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.error("❌ Set TELEGRAM_TOKEN and GROQ_API_KEY env vars.");
  process.exit(1);
}

// ── Express keep-alive ────────────────────────────────────────────────────────
const app = express();
app.get("/",       (_, res) => res.send("🤖 Freddy v2 is alive!"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Keep-alive on port ${PORT}`));

// ── Telegram + Groq ───────────────────────────────────────────────────────────
const bot  = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Persona ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Freddy, a friendly and capable AI agent on Telegram.

Personality:
- Warm, cheerful, approachable — like a knowledgeable best friend
- Casual but clear. No corporate tone.
- Proactive: suggest next steps when users seem stuck
- Use emojis sparingly (1-2 max, only when natural)
- Never say "As an AI..." — you ARE Freddy

Available commands:
- /search <query> — Real-time web search
- /voice <message> — Voice reply using Groq Orpheus TTS
- /summarize <url> — Summarize a webpage
- /file <description> — Create and send a file
- /reset — Clear memory

Keep replies concise unless detail is needed.`;

// ── Memory ────────────────────────────────────────────────────────────────────
const conversations = {};
function getHistory(uid) {
  if (!conversations[uid]) conversations[uid] = [];
  return conversations[uid];
}
function addToHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
}

// ── Thinking animation ────────────────────────────────────────────────────────
const FRAMES = ["✦ Thinking", "✦ Thinking.", "✦ Thinking..", "✦ Thinking..."];

async function sendThinking(chatId) {
  const msg = await bot.sendMessage(chatId, FRAMES[0]);
  return msg.message_id;
}

function animateThinking(chatId, msgId, stop) {
  let f = 0;
  const iv = setInterval(async () => {
    if (stop.stopped) { clearInterval(iv); return; }
    f = (f + 1) % FRAMES.length;
    try { await bot.editMessageText(FRAMES[f], { chat_id: chatId, message_id: msgId }); } catch (_) {}
  }, 1000);
}

// ── Groq chat helper ──────────────────────────────────────────────────────────
async function askGroq(uid, userMsg, extraContext = "") {
  const fullMsg = extraContext ? `${userMsg}\n\n[Context]:\n${extraContext}` : userMsg;
  addToHistory(uid, "user", fullMsg);
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...getHistory(uid)],
    temperature: 0.75,
    max_tokens: 1024,
  });
  const reply = res.choices[0]?.message?.content?.trim() || "Hmm, no response. Try again?";
  addToHistory(uid, "assistant", reply);
  return reply;
}

// ── Groq Orpheus TTS ──────────────────────────────────────────────────────────
async function textToVoice(text, chatId) {
  const tmpFile = path.join(os.tmpdir(), `freddy_${Date.now()}.wav`);
  const response = await groq.audio.speech.create({
    model: "canopylabs/orpheus-v1-english",
    voice: "dan",          // friendly male voice
    input: text.slice(0, 500),
    response_format: "wav",
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(tmpFile, buffer);
  await bot.sendVoice(chatId, tmpFile);
  fs.unlinkSync(tmpFile);
}

// ── Web Search (Wikipedia API) ────────────────────────────────────────────────
async function webSearch(query) {
  try {
    const res = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: {
        action: "query",
        list: "search",
        srsearch: query,
        format: "json",
        srlimit: 3,
        srprop: "snippet",
      },
      headers: { "User-Agent": "FreddyBot/2.0 (telegram bot)" },
      timeout: 8000,
    });
    const results = res.data?.query?.search || [];
    if (!results.length) return "No results found for that query.";
    return results
      .map(r => `*${r.title}*\n${r.snippet.replace(/<[^>]+>/g, "")}`)
      .join("\n\n");
  } catch (e) {
    return "Search failed: " + e.message;
  }
}

// ── Link Summarizer ───────────────────────────────────────────────────────────
async function fetchPageText(url) {
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36" },
    timeout: 10000,
  });
  const $ = cheerio.load(res.data);
  $("script, style, nav, footer, header, aside, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
}

// ── File Creator ──────────────────────────────────────────────────────────────
async function createAndSendFile(uid, description, chatId) {
  const content = await askGroq(
    uid,
    `Write the full content for a file described as: "${description}". Output ONLY the raw file content, no explanation, no markdown fences.`
  );
  const extMatch = description.match(/\.(js|py|txt|html|css|json|md|sh)$/i);
  const ext = extMatch ? extMatch[0] : ".txt";
  const tmpFile = path.join(os.tmpdir(), `freddy_${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, content);
  await bot.sendDocument(chatId, tmpFile, {}, { filename: `freddy_output${ext}` });
  fs.unlinkSync(tmpFile);
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const name = msg.from.first_name || "there";
  await bot.sendMessage(msg.chat.id,
    `Hey ${name}! 👋 I'm *Freddy v2*, your friendly AI agent!\n\n` +
    `*Commands:*\n` +
    `🌐 /search <query>\n` +
    `🎵 /voice <text>\n` +
    `📝 /summarize <url>\n` +
    `📁 /file <description>\n` +
    `🧹 /reset\n\n` +
    `Or just chat with me!`,
    { parse_mode: "Markdown" }
  );
});

// ── /reset ────────────────────────────────────────────────────────────────────
bot.onText(/\/reset/, async (msg) => {
  conversations[msg.from.id] = [];
  await bot.sendMessage(msg.chat.id, "Memory cleared! Fresh start 🧹");
});

// ── /search ───────────────────────────────────────────────────────────────────
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const stop   = { stopped: false };
  const mid    = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  try {
    const searchResult = await webSearch(match[1]);
    const reply = await askGroq(msg.from.id, `User searched: "${match[1]}". Respond helpfully.`, searchResult);
    stop.stopped = true;
    await bot.editMessageText(reply, { chat_id: chatId, message_id: mid, parse_mode: "Markdown" });
  } catch (e) {
    stop.stopped = true;
    await bot.editMessageText("⚠️ Search failed: " + e.message, { chat_id: chatId, message_id: mid }).catch(() => {});
  }
});

// ── /voice ────────────────────────────────────────────────────────────────────
bot.onText(/\/voice (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const stop   = { stopped: false };
  const mid    = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  try {
    const reply = await askGroq(msg.from.id, match[1]);
    stop.stopped = true;
    await bot.editMessageText(reply, { chat_id: chatId, message_id: mid, parse_mode: "Markdown" });
    await textToVoice(reply, chatId);
  } catch (e) {
    stop.stopped = true;
    await bot.editMessageText("⚠️ Voice failed: " + e.message, { chat_id: chatId, message_id: mid }).catch(() => {});
  }
});

// ── /summarize ────────────────────────────────────────────────────────────────
bot.onText(/\/summarize (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const stop   = { stopped: false };
  const mid    = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  try {
    const pageText = await fetchPageText(match[1].trim());
    const reply    = await askGroq(msg.from.id, "Summarize this webpage clearly and concisely:", pageText);
    stop.stopped = true;
    await bot.editMessageText(reply, { chat_id: chatId, message_id: mid, parse_mode: "Markdown" });
  } catch (e) {
    stop.stopped = true;
    await bot.editMessageText("⚠️ Could not fetch that URL: " + e.message, { chat_id: chatId, message_id: mid }).catch(() => {});
  }
});

// ── /file ─────────────────────────────────────────────────────────────────────
bot.onText(/\/file (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const stop   = { stopped: false };
  const mid    = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  try {
    await createAndSendFile(msg.from.id, match[1], chatId);
    stop.stopped = true;
    await bot.editMessageText("📁 Here's your file!", { chat_id: chatId, message_id: mid });
  } catch (e) {
    stop.stopped = true;
    await bot.editMessageText("⚠️ File creation failed: " + e.message, { chat_id: chatId, message_id: mid }).catch(() => {});
  }
});

// ── Normal chat ───────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const stop   = { stopped: false };
  const mid    = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  try {
    const reply = await askGroq(msg.from.id, msg.text);
    stop.stopped = true;
    await bot.editMessageText(reply, { chat_id: chatId, message_id: mid, parse_mode: "Markdown" });
  } catch (e) {
    stop.stopped = true;
    await bot.editMessageText("⚠️ Something went wrong. Try again!", { chat_id: chatId, message_id: mid }).catch(() => {});
  }
});

console.log("🤖 Freddy v2 is online!");
