// Example client for the Cloudflare WebSocket API.
// Usage:
//   CF_WS_URL=wss://YOUR-WORKER.workers.dev/ws CLIENT_TOKEN=... node client.mjs

import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const baseUrl = process.env.CF_WS_URL;
const token = process.env.CLIENT_TOKEN;
const mode = process.env.MODE || "text"; // text | image | both
const prompt = process.env.PROMPT || "Write a short fantasy story about a lighthouse at the edge of the world.";
const resolution = process.env.RESOLUTION || "512x768";

if (!baseUrl || !token) {
  throw new Error("Set CF_WS_URL and CLIENT_TOKEN first.");
}

const url = new URL(baseUrl);
url.searchParams.set("role", "client");
const ws = new WebSocket(url);
let submitted = false;
const tasksWithChunks = new Set();

ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
ws.on("message", (buffer) => {
  const text = buffer.toString();
  if (text === "pong") return;
  let message;
  try { message = JSON.parse(text); } catch { console.log(text); return; }

  if (message.type === "auth_ok" && !submitted) {
    submitted = true;
    ws.send(JSON.stringify({ type: "submit", mode, prompt, resolution }));
  } else if (message.type === "accepted") {
    console.log("Accepted:", message);
  } else if (message.type === "chunk") {
    tasksWithChunks.add(message.taskId);
    process.stdout.write(message.text);
  } else if (message.type === "result") {
    if (message.mode === "image") {
      const prefix = `image-${message.taskId}`;
      const base64 = message.response.split(",", 2)[1];
      const mime = message.response.slice(5, message.response.indexOf(";"));
      const extension = mime.split("/")[1] || "png";
      writeFileSync(`${prefix}.${extension}`, Buffer.from(base64, "base64"));
      console.log(`\nSaved image to ${prefix}.${extension}`);
    } else {
      if (!tasksWithChunks.has(message.taskId)) console.log(message.response);
      else console.log("\n[Final text result received]");
    }
  } else if (message.type === "task_error" || message.type === "error") {
    console.error("\nError:", message.error);
  } else if (message.type === "request_done") {
    console.log("\nRequest finished:", message.status);
    ws.close();
  }
});


ws.on("error", (error) => console.error("WebSocket error:", error.message));
