
import { chromium } from "playwright";
import WebSocket from "ws";
import fs from "node:fs/promises";
import os from "node:os";

const PERCHANCE_URL = process.env.PERCHANCE_URL || "https://perchance.org/fu677q3rr4";
const CF_WS_URL = process.env.CF_WS_URL;
const NODE_TOKEN = process.env.NODE_TOKEN;
const NODE_ID = process.env.NODE_ID || `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
const PROFILE_DIR = process.env.PROFILE_DIR || "/data/profile";
const TEXT_SLOTS = Number.parseInt(process.env.TEXT_SLOTS || "2", 10);
const IMAGE_SLOTS = Number.parseInt(process.env.IMAGE_SLOTS || "1", 10);
const ACCEPT_PERCHANCE_WARNING = process.env.ACCEPT_PERCHANCE_WARNING === "true";

const HEARTBEAT_MS = 25_000;
const MAX_IMAGE_DATA_URL_CHARS = 6_000_000;
const WARNING_ACTION_RE = /(?:continue\s+to\s+page|i['’]?m\s+over\s+18.*show\s+content)/i;

if (!CF_WS_URL || !NODE_TOKEN) {
  console.error("Missing CF_WS_URL or NODE_TOKEN environment variable.");
  process.exit(1);
}

let browserContext;
let currentPage;
let generatorFrame;
let socket;
const activeJobs = new Set();

function log(...args) {
  console.log(new Date().toISOString(), "[node]", ...args);
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    log("WebSocket send failed:", error.message);
    return false;
  }
}

async function findPerchanceWarningAction(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const candidates = [
          frame.getByRole("button", { name: /continue\s+to\s+page/i }).first(),
          frame.getByRole("link", { name: /continue\s+to\s+page/i }).first(),
          frame.getByRole("button", { name: /i['’]?m\s+over\s+18.*show\s+content/i }).first(),
          frame.getByRole("link", { name: /i['’]?m\s+over\s+18.*show\s+content/i }).first(),
          frame.locator("button, a, [role='button']").filter({ hasText: WARNING_ACTION_RE }).first(),
          frame.getByText(/continue\s+to\s+page/i).first(),
          frame.getByText(/i['’]?m\s+over\s+18.*show\s+content/i).first(),
        ];

        for (const candidate of candidates) {
          try {
            if (await candidate.count() > 0 && await candidate.isVisible()) {
              return { frame, locator: candidate };
            }
          } catch {}
        }
      } catch {}
    }

    await page.waitForTimeout(300).catch(() => {});
  }

  return null;
}

async function continuePastPerchanceWarning(page) {
  const action = await findPerchanceWarningAction(page);

  if (!action) {
    log("No Perchance continuation warning detected.");
    return;
  }

  if (!ACCEPT_PERCHANCE_WARNING) {
    throw new Error(
      "Perchance is showing a content/age confirmation. Review it yourself and set " +
      "ACCEPT_PERCHANCE_WARNING=true only if you are legally permitted to view the page " +
      "and choose to accept the confirmation."
    );
  }

  log("Perchance continuation warning detected; clicking the visible confirmation.");

  await action.locator.click({ timeout: 15_000 });
  await page.waitForTimeout(2_000);

  log("Perchance continuation action completed; checking generator frames.");
}

async function locateGeneratorFrame(page, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let nextDiagnosticAt = 0;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const ready = await frame.evaluate(() => {
          let api = window.root;

          if (!api) {
            try {
              api = window.eval("typeof root !== 'undefined' ? root : null");
            } catch {}
          }

          return Boolean(
            api &&
            typeof api.generateText === "function" &&
            typeof api.generateImage === "function"
          );
        });

        if (ready) return frame;
      } catch {}
    }

    if (Date.now() >= nextDiagnosticAt) {
      const frameUrls = page.frames().map((frame) => {
        try {
          return frame.url();
        } catch {
          return "<detached frame>";
        }
      });

      log("Still searching for the Perchance generation API. Frames:", frameUrls);
      nextDiagnosticAt = Date.now() + 20_000;
    }

    await page.waitForTimeout(1_000).catch(() => {});
  }

  throw new Error(
    "Could not find Perchance root.generateText/root.generateImage within " +
    `${Math.round(timeoutMs / 1000)} seconds. Check that the continuation warning was accepted, ` +
    "the generator page finished loading, and the API is available in one of its frames."
  );
}

async function startBrowser() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  log("Launching headless Chromium with persistent profile", PROFILE_DIR);

  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  currentPage = browserContext.pages()[0] || await browserContext.newPage();

  await currentPage.exposeFunction("__cloudflareEmitChunk", (payload) => {
    if (!payload || typeof payload.taskId !== "string" || typeof payload.text !== "string") return;
    if (payload.text.length > 64_000) return;

    send({
      type: "chunk",
      taskId: payload.taskId,
      text: payload.text,
    });
  });

  currentPage.on("crash", () => {
    log("Perchance page crashed; reconnecting node.");
    try {
      socket?.close(1012, "Perchance page crashed");
    } catch {}
  });

  await currentPage.goto(PERCHANCE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  log("Opened", PERCHANCE_URL);

  await continuePastPerchanceWarning(currentPage);

  generatorFrame = await locateGeneratorFrame(currentPage);

  log("Found Perchance generation API in frame:", generatorFrame.url());
}

async function runJob(job) {
  if (activeJobs.has(job.taskId)) return;

  activeJobs.add(job.taskId);
  send({ type: "started", taskId: job.taskId });

  try {
    if (!generatorFrame || generatorFrame.isDetached()) {
      generatorFrame = await locateGeneratorFrame(currentPage, 30_000);
    }

    const result = await generatorFrame.evaluate(async (input) => {
      let api = window.root;

      if (!api) {
        try {
          api = window.eval("typeof root !== 'undefined' ? root : null");
        } catch {}
      }

      if (!api) {
        throw new Error("Perchance root API disappeared.");
      }

      if (input.mode === "image") {
        const generated = await api.generateImage(
          input.prompt,
          { resolution: input.resolution }
        );

        const dataUrl = generated && generated.dataUrl;

        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
          throw new Error("Perchance image generation returned no image data URL.");
        }

        return { response: dataUrl };
      }

      if (input.mode === "text") {
        let previousFullText = "";
        let appendCompatible = true;

        const generated = await api.generateText({
          instruction: input.prompt,

          onChunk: (chunkData) => {
            const fullText =
              chunkData && typeof chunkData.fullTextSoFar === "string"
                ? chunkData.fullTextSoFar
                : null;

            if (fullText === null || !appendCompatible) return;

            if (!fullText.startsWith(previousFullText)) {
              appendCompatible = false;
              return;
            }

            const delta = fullText.slice(previousFullText.length);
            previousFullText = fullText;

            if (delta) {
              window.__cloudflareEmitChunk({
                taskId: input.taskId,
                text: delta,
              });
            }
          },
        });

        const text = generated && generated.text;

        if (typeof text !== "string" || !text.length) {
          throw new Error("Perchance text generation returned an empty result.");
        }

        return { response: text };
      }

      throw new Error(`Unsupported job mode: ${input.mode}`);
    }, {
      taskId: job.taskId,
      mode: job.mode,
      prompt: job.prompt,
      resolution: job.resolution,
    });

    if (job.mode === "image" && result.response.length > MAX_IMAGE_DATA_URL_CHARS) {
      throw new Error(
        "Image result is too large for the configured Cloudflare WebSocket payload limit."
      );
    }

    send({
      type: "result",
      taskId: job.taskId,
      response: result.response,
    });

    log("Job completed", job.taskId, job.mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    log("Job failed", job.taskId, message);

    send({
      type: "error",
      taskId: job.taskId,
      error: message,
    });
  } finally {
    activeJobs.delete(job.taskId);
  }
}

function openCloudflareSocket() {
  return new Promise((resolve, reject) => {
    const url = new URL(CF_WS_URL);
    url.searchParams.set("role", "node");

    const ws = new WebSocket(url.toString(), {
      handshakeTimeout: 30_000,
    });

    socket = ws;
    let settled = false;

    ws.on("open", () => {
      log("Connected to Cloudflare; authenticating.");

      ws.send(JSON.stringify({
        type: "auth",
        token: NODE_TOKEN,
      }));
    });

    ws.on("message", (buffer) => {
      const raw = buffer.toString();

      if (raw === "pong") return;

      let message;

      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (message.type === "auth_ok") {
        ws.send(JSON.stringify({
          type: "register",
          nodeId: NODE_ID,
          textSlots: TEXT_SLOTS,
          imageSlots: IMAGE_SLOTS,
        }));
      } else if (message.type === "node_ready") {
        log("Registered with Cloudflare:", message);

        if (!settled) {
          settled = true;
          resolve(ws);
        }
      } else if (message.type === "job") {
        void runJob(message);
      } else if (message.type === "error") {
        log("Cloudflare error:", message.error);

        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Cloudflare rejected node registration: ${message.error || "unknown error"}`
            )
          );
        }
      }
    });

    ws.on("close", (code, reason) => {
      log("Cloudflare socket closed", code, reason.toString());

      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket closed before registration (${code})`));
      }
    });

    ws.on("error", (error) => {
      log("WebSocket error:", error.message);

      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function main() {
  while (true) {
    try {
      await startBrowser();
      await openCloudflareSocket();

      log(`Node online. Capacity: ${TEXT_SLOTS} text + ${IMAGE_SLOTS} image.`);

      const heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, HEARTBEAT_MS);

      await new Promise((resolve) => {
        socket.once("close", resolve);
        currentPage.once("close", resolve);
        currentPage.once("crash", resolve);
      });

      clearInterval(heartbeat);
    } catch (error) {
      log("Node cycle ended:", error.message || error);
    }

    try {
      socket?.terminate();
    } catch {}

    try {
      await browserContext?.close();
    } catch {}

    socket = null;
    browserContext = null;
    currentPage = null;
    generatorFrame = null;
    activeJobs.clear();

    log("Restarting browser/node connection in 5 seconds.");

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

process.on("SIGTERM", async () => {
  log("SIGTERM received; shutting down.");

  try {
    socket?.close(1001, "Container stopping");
  } catch {}

  try {
    await browserContext?.close();
  } catch {}

  process.exit(0);
});

main().catch((error) => {
  log("Fatal node error:", error);
  process.exit(1);
});
