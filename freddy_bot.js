/**
 * Freddy Bot v3 — Agentic AI on Telegram
 * Tools: Web Search, Voice (Groq Orpheus via HTTP), Image Gen (Pollinations),
 *        Link Summarizer, File Creator — all auto-routed by AI
 *
 * npm install node-telegram-bot-api groq-sdk express axios cheerio
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

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const PORT           = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.error("❌ Set TELEGRAM_TOKEN and GROQ_API_KEY");
  process.exit(1);
}

// ── Express keep-alive ────────────────────────────────────────────────────────
const app = express();
app.get("/",       (_, res) => res.send("🤖 Freddy v3 is alive!"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🌐 Keep-alive on port ${PORT}`));

const bot  = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

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

// ══════════════════════════════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════════════════════════════

// 1. Web Search (Wikipedia)
async function toolSearch(query) {
  const res = await axios.get("https://en.wikipedia.org/w/api.php", {
    params: { action: "query", list: "search", srsearch: query, format: "json", srlimit: 3, srprop: "snippet" },
    headers: { "User-Agent": "FreddyBot/3.0" },
    timeout: 8000,
  });
  const results = res.data?.query?.search || [];
  if (!results.length) return "No results found.";
  return results.map(r => `${r.title}: ${r.snippet.replace(/<[^>]+>/g, "")}`).join("\n\n");
}

// 2. Voice TTS (Groq Orpheus via raw HTTP)
async function toolVoice(text, chatId) {
  const response = await axios.post(
    "https://api.groq.com/openai/v1/audio/speech",
    {
      model: "playai-tts",
      voice: "Fritz-PlayAI",
      input: text.slice(0, 500),
      response_format: "mp3",
    },
    {
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout: 20000,
    }
  );
  const tmpFile = path.join(os.tmpdir(), `freddy_${Date.now()}.mp3`);
  await fs.promises.writeFile(tmpFile, Buffer.from(response.data));
  await bot.sendVoice(chatId, tmpFile);
  fs.unlinkSync(tmpFile);
}

// 3. Image Generation (Pollinations.ai)
async function toolImage(prompt, chatId) {
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&enhance=true`;
  // Pollinations generates on the fly — fetch as buffer
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const tmpFile = path.join(os.tmpdir(), `freddy_img_${Date.now()}.jpg`);
  await fs.promises.writeFile(tmpFile, Buffer.from(res.data));
  await bot.sendPhoto(chatId, tmpFile, { caption: `🎨 "${prompt}"` });
  fs.unlinkSync(tmpFile);
}

// 4. Summarize URL
async function toolSummarize(url) {
  const res = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36" },
    timeout: 10000,
  });
  const $ = cheerio.load(res.data);
  $("script, style, nav, footer, header, aside, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
}

// 5. Create File
async function toolFile(content, description, chatId) {
  const extMatch = description.match(/\.(js|py|txt|html|css|json|md|sh)$/i);
  const ext = extMatch ? extMatch[0] : ".txt";
  const tmpFile = path.join(os.tmpdir(), `freddy_${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, content);
  await bot.sendDocument(chatId, tmpFile, {}, { filename: `freddy_output${ext}` });
  fs.unlinkSync(tmpFile);
}

// ══════════════════════════════════════════════════════════════════════════════
// AGENT ROUTER — AI decides which tools to use
// ══════════════════════════════════════════════════════════════════════════════
const AGENT_SYSTEM = `You are Freddy, a friendly and capable AI agent on Telegram.

You have these tools available. Decide which to use based on the user's message:
- SEARCH:<query> → search Wikipedia for info
- IMAGE:<prompt> → generate an image with Pollinations AI
- VOICE → speak your reply out loud (add this tag if user asks for voice)
- SUMMARIZE:<url> → summarize a webpage
- FILE:<filename.ext> → create a file (put file content after your text reply)
- NONE → just reply normally

Rules:
- Always reply with your text message first
- Add tool tags on new lines at the end, like: SEARCH:nodejs history
- You can use multiple tools in one reply
- For FILE, add a line: FILE_CONTENT_START then the raw file content then FILE_CONTENT_END
- For IMAGE, describe it vividly for best results
- Be warm, friendly, casual. Use emojis sparingly (1-2 max).
- Never say "As an AI" — you ARE Freddy.
- If user asks for voice reply, add VOICE tag.
- If user asks to search something, add SEARCH tag.
- If user asks for an image, add IMAGE tag.
- If user asks for a file, add FILE tag.`;

async function agentReply(uid, userMsg, chatId, stop, mid) {
  addToHistory(uid, "user", userMsg);

  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: AGENT_SYSTEM }, ...getHistory(uid)],
    temperature: 0.75,
    max_tokens: 2048,
  });

  const raw = res.choices[0]?.message?.content?.trim() || "Hmm, no response.";
  addToHistory(uid, "assistant", raw);

  // Parse text vs tool tags
  const lines = raw.split("\n");
  const textLines = [];
  const toolTags  = [];
  let fileContent = null;
  let inFile = false;
  const fileLines = [];

  for (const line of lines) {
    if (line.startsWith("FILE_CONTENT_START")) { inFile = true; continue; }
    if (line.startsWith("FILE_CONTENT_END"))   { inFile = false; continue; }
    if (inFile) { fileLines.push(line); continue; }

    if (line.match(/^(SEARCH|IMAGE|VOICE|SUMMARIZE|FILE):/i) || line.match(/^VOICE$/i)) {
      toolTags.push(line.trim());
    } else {
      textLines.push(line);
    }
  }
  if (fileLines.length) fileContent = fileLines.join("\n");

  const replyText = textLines.join("\n").trim() || "Done!";

  // Send text reply
  stop.stopped = true;
  try {
    await bot.editMessageText(replyText, { chat_id: chatId, message_id: mid, parse_mode: "Markdown" });
  } catch (_) {
    await bot.sendMessage(chatId, replyText, { parse_mode: "Markdown" });
  }

  // Execute tools
  for (const tag of toolTags) {
    try {
      if (tag.startsWith("SEARCH:")) {
        const query = tag.slice(7).trim();
        const results = await toolSearch(query);
        // Feed results back to AI for a follow-up if needed (silent)
        await bot.sendMessage(chatId, `🔍 *Search results for "${query}":*\n${results.slice(0, 800)}`, { parse_mode: "Markdown" });

      } else if (tag.startsWith("IMAGE:")) {
        const prompt = tag.slice(6).trim();
        await bot.sendChatAction(chatId, "upload_photo");
        await toolImage(prompt, chatId);

      } else if (tag === "VOICE" || tag.startsWith("VOICE")) {
        await bot.sendChatAction(chatId, "record_voice");
        await toolVoice(replyText, chatId);

      } else if (tag.startsWith("SUMMARIZE:")) {
        const url = tag.slice(10).trim();
        const text = await toolSummarize(url);
        const summary = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: `Summarize this concisely:\n${text}` }],
          max_tokens: 512,
        });
        await bot.sendMessage(chatId, summary.choices[0].message.content, { parse_mode: "Markdown" });

      } else if (tag.startsWith("FILE:")) {
        const filename = tag.slice(5).trim();
        const content  = fileContent || replyText;
        await toolFile(content, filename, chatId);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ Tool error: ${e.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  const name = msg.from.first_name || "there";
  await bot.sendMessage(msg.chat.id,
    `Hey ${name}! 👋 I'm *Freddy v3* — your AI agent!\n\n` +
    `Just talk to me naturally. I'll figure out what tools to use.\n\n` +
    `*Examples:*\n` +
    `• "Search for black holes"\n` +
    `• "Generate an image of a cyberpunk city"\n` +
    `• "Summarize https://example.com"\n` +
    `• "Write me a Python script for X"\n` +
    `• "Reply with voice"\n\n` +
    `_Or use /search /image /voice /summarize /file /reset_`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/reset/, async (msg) => {
  conversations[msg.from.id] = [];
  await bot.sendMessage(msg.chat.id, "Memory cleared! 🧹");
});

// Manual commands (still work)
bot.onText(/\/search (.+)/, async (msg, match) => {
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, `Search for: ${match[1]}`, chatId, stop, mid);
});

bot.onText(/\/image (.+)/, async (msg, match) => {
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, `Generate an image of: ${match[1]}`, chatId, stop, mid);
});

bot.onText(/\/voice (.+)/, async (msg, match) => {
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, `${match[1]} (reply with voice)`, chatId, stop, mid);
});

bot.onText(/\/summarize (.+)/, async (msg, match) => {
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, `Summarize this URL: ${match[1]}`, chatId, stop, mid);
});

bot.onText(/\/file (.+)/, async (msg, match) => {
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, `Create a file: ${match[1]}`, chatId, stop, mid);
});

// Normal chat → agent handles everything
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id, stop = { stopped: false };
  const mid = await sendThinking(chatId);
  animateThinking(chatId, mid, stop);
  await agentReply(msg.from.id, msg.text, chatId, stop, mid);
});

console.log("🤖 Freddy v3 is online!");
