
import { chromium } from "playwright";
import WebSocket from "ws";
import fs from "node:fs/promises";
import os from "node:os";
import https from "node:https";
import dns from "node:dns/promises";

// ============================================================
// CONFIGURATION
// ============================================================

const PERCHANCE_URL =
  process.env.PERCHANCE_URL || "https://perchance.org/fu677q3rr4";
const CF_WS_URL = process.env.CF_WS_URL;
const NODE_TOKEN = process.env.NODE_TOKEN;
const NODE_ID =
  process.env.NODE_ID || `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
const PROFILE_DIR = process.env.PROFILE_DIR || "/data/profile";
const TEXT_SLOTS = Number.parseInt(process.env.TEXT_SLOTS || "2", 10);
const IMAGE_SLOTS = Number.parseInt(process.env.IMAGE_SLOTS || "1", 10);
const ACCEPT_PERCHANCE_WARNING =
  process.env.ACCEPT_PERCHANCE_WARNING === "true";

const HEARTBEAT_MS = 25_000;
const API_DISCOVERY_TIMEOUT_MS = 180_000;
const MAX_IMAGE_DATA_URL_CHARS = 6_000_000;
const WARNING_ACTION_RE =
  /(?:continue\s+to\s+page|i['’]?m\s+over\s+18.*show\s+content)/i;

if (!CF_WS_URL || !NODE_TOKEN) {
  console.error("Missing CF_WS_URL or NODE_TOKEN environment variable.");
  process.exit(1);
}

if (!Number.isInteger(TEXT_SLOTS) || TEXT_SLOTS < 0 || TEXT_SLOTS > 4) {
  console.error("TEXT_SLOTS must be an integer from 0 to 4.");
  process.exit(1);
}
if (!Number.isInteger(IMAGE_SLOTS) || IMAGE_SLOTS < 0 || IMAGE_SLOTS > 2) {
  console.error("IMAGE_SLOTS must be an integer from 0 to 2.");
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

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    log("WebSocket send failed:", errorText(error));
    return false;
  }
}

// ============================================================
// OUTBOUND IPV4 CONNECTIVITY DIAGNOSTICS
// ============================================================

async function networkDiagnostics() {
  const hostname = "brunhild.challenges.cloudflare.com";

  const candidateIPv4 = [
    "104.18.16.146",
    "104.18.17.146",
  ];

  log("========== FORCED IPV4 CONNECTIVITY TEST BEGIN ==========");

  let actualIPv4 = [];

  try {
    actualIPv4 = await dns.resolve4(hostname);

    log(
      "[ACTUAL IPV4 DNS RECORDS]",
      hostname,
      JSON.stringify(actualIPv4)
    );
  } catch (error) {
    log(
      "[NO IPV4 DNS RECORDS]",
      hostname,
      error.code || errorText(error)
    );
  }

  // Test actual A records first, then candidate IPv4 endpoints
  // inferred from the IPv6 addresses observed previously.
  const targets = [
    ...new Set([
      ...actualIPv4,
      ...candidateIPv4
    ])
  ];

  for (const ip of targets) {
    await new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      log("[TESTING IPV4]", hostname, "via", ip);

      const request = https.get(
        {
          hostname,
          servername: hostname,
          path: "/",
          timeout: 10_000,

          lookup: (_lookupHostname, _options, callback) => {
            callback(null, ip, 4);
          },

          headers: {
            "User-Agent": "PerchanceNode-Network-Diagnostic/1.0",
          },
        },
        (response) => {
          log(
            "[FORCED IPV4 RESULT]",
            ip,
            "HTTP",
            response.statusCode,
            "remoteAddress=",
            response.socket?.remoteAddress || "unknown"
          );

          response.resume();

          response.on("end", finish);

          response.on("error", (error) => {
            log(
              "[FORCED IPV4 RESPONSE ERROR]",
              ip,
              error.code || errorText(error)
            );

            finish();
          });
        }
      );

      request.on("timeout", () => {
        log("[FORCED IPV4 TIMEOUT]", ip);
        request.destroy();
        finish();
      });

      request.on("error", (error) => {
        log(
          "[FORCED IPV4 ERROR]",
          ip,
          error.code || errorText(error)
        );

        finish();
      });
    });
  }

  log("========== FORCED IPV4 CONNECTIVITY TEST END ==========");
}

// ============================================================
// PAGE / NETWORK DIAGNOSTICS
// ============================================================

function attachPageDiagnostics(page) {
  page.on("request", (request) => {
    try {
      if (
        request.isNavigationRequest() &&
        request.resourceType() === "document"
      ) {
        let frameUrl = "unknown";

        try {
          frameUrl = request.frame().url();
        } catch {}

        log(
          "[DOCUMENT REQUEST]",
          request.url(),
          "frame-before-nav=",
          frameUrl
        );
      }
    } catch {}
  });

  page.on("requestfailed", (request) => {
    let frameUrl = "unknown";

    try {
      frameUrl = request.frame().url();
    } catch {}

    let failure = "unknown network error";

    try {
      failure = request.failure()?.errorText || failure;
    } catch {}

    log(
      "[REQUEST FAILED]",
      "type=", request.resourceType(),
      "method=", request.method(),
      "url=", request.url(),
      "frame=", frameUrl,
      "error=", failure
    );
  });

  page.on("response", (response) => {
    if (response.status() < 400) return;

    const request = response.request();

    if (
      request.resourceType() === "document" ||
      /perchance\.org|challenges\.cloudflare\.com/i.test(response.url())
    ) {
      log(
        "[HTTP ERROR]",
        response.status(),
        "type=", request.resourceType(),
        "url=", response.url()
      );
    }
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      log("[BROWSER CONSOLE ERROR]", message.text());
    }
  });

  page.on("pageerror", (error) => {
    log("[PAGE JAVASCRIPT ERROR]", errorText(error));
  });

  page.on("frameattached", (frame) => {
    log("[FRAME ATTACHED]", frame.url() || "<pending URL>");
  });

  page.on("framenavigated", (frame) => {
    let frameName = "";

    try {
      frameName = frame.name();
    } catch {}

    log(
      "[FRAME NAVIGATED]",
      "name=",
      frameName,
      "url=",
      frame.url()
    );
  });

  page.on("framedetached", (frame) => {
    let oldUrl = "unknown";

    try {
      oldUrl = frame.url();
    } catch {}

    log("[FRAME DETACHED]", oldUrl);
  });

  page.on("crash", () => {
    log("[PAGE CRASHED] Perchance page crashed; closing node socket.");

    try {
      socket?.close(1012, "Perchance page crashed");
    } catch {}
  });
}

async function dumpPageDiagnostics(page, label) {
  log(`========== ${label}: PAGE SNAPSHOT BEGIN ==========`);

  try {
    const pageInfo = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 1200) || "",

      iframes: Array.from(document.querySelectorAll("iframe")).map((frame) => ({
        srcAttribute: frame.getAttribute("src"),
        resolvedSrc: frame.src,
        title: frame.title,
        name: frame.name,
        id: frame.id,
        sandbox: frame.getAttribute("sandbox"),
      })),
    }));

    log("[PAGE SNAPSHOT]", JSON.stringify(pageInfo));

  } catch (error) {
    log("[PAGE SNAPSHOT FAILED]", errorText(error));
  }

  for (const [index, frame] of page.frames().entries()) {
    try {
      const details = await frame.evaluate(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        rootType: typeof window.root,
        generateText: typeof window.root?.generateText,
        generateImage: typeof window.root?.generateImage,
        bodyText: document.body?.innerText?.slice(0, 700) || "",
      }));

      log(`[FRAME SNAPSHOT ${index}]`, JSON.stringify(details));

    } catch (error) {
      log(
        `[FRAME SNAPSHOT ${index} FAILED]`,
        frame.url(),
        errorText(error)
      );
    }
  }

  log(`========== ${label}: PAGE SNAPSHOT END ==========`);
}

// ============================================================
// PERCHANCE CONTENT CONFIRMATION
// ============================================================

async function findPerchanceWarningAction(page, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const candidates = [
          frame.getByRole("button", {
            name: /continue\s+to\s+page/i
          }).first(),

          frame.getByRole("link", {
            name: /continue\s+to\s+page/i
          }).first(),

          frame.getByRole("button", {
            name: /i['’]?m\s+over\s+18.*show\s+content/i,
          }).first(),

          frame.getByRole("link", {
            name: /i['’]?m\s+over\s+18.*show\s+content/i,
          }).first(),

          frame.locator("button, a, [role='button']")
            .filter({ hasText: WARNING_ACTION_RE })
            .first(),

          frame.getByText(/continue\s+to\s+page/i).first(),

          frame.getByText(
            /i['’]?m\s+over\s+18.*show\s+content/i
          ).first(),
        ];

        for (const candidate of candidates) {
          try {
            if (
              await candidate.count() > 0 &&
              await candidate.isVisible()
            ) {
              return {
                frame,
                locator: candidate
              };
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
      "Perchance is showing a content/age confirmation. Set " +
      "ACCEPT_PERCHANCE_WARNING=true only if you are legally permitted " +
      "to view the page and choose to accept the confirmation."
    );
  }

  log("Perchance continuation warning detected; clicking the visible confirmation.");

  await action.locator.click({
    timeout: 15_000
  });

  await page.waitForTimeout(2_000);

  log("Perchance continuation action completed.");
}

// ============================================================
// GENERATOR FRAME DISCOVERY
// ============================================================

async function inspectFrameForGenerator(frame) {
  return frame.evaluate(() => {
    let api = window.root;

    if (!api) {
      try {
        api = window.eval(
          "typeof root !== 'undefined' ? root : null"
        );
      } catch {}
    }

    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      rootType: typeof api,
      generateText: typeof api?.generateText,
      generateImage: typeof api?.generateImage,
      bodyText: document.body?.innerText?.slice(0, 500) || "",

      hasGeneratorApi:
        typeof api?.generateText === "function" &&
        typeof api?.generateImage === "function"
    };
  });
}

async function locateGeneratorFrame(
  page,
  timeoutMs = API_DISCOVERY_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;

  let nextDiagnosticAt = 0;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const info = await inspectFrameForGenerator(frame);

        if (info.hasGeneratorApi) {
          log("[GENERATOR API FOUND]", JSON.stringify(info));
          return frame;
        }
      } catch {
        // A frame can be navigating or detached.
      }
    }

    if (Date.now() >= nextDiagnosticAt) {
      const frameSummary = [];

      for (const frame of page.frames()) {
        try {
          frameSummary.push(
            await inspectFrameForGenerator(frame)
          );
        } catch (error) {
          frameSummary.push({
            url: frame.url(),
            inspectionError: errorText(error)
          });
        }
      }

      log(
        "[GENERATOR SEARCH SNAPSHOT]",
        JSON.stringify(frameSummary)
      );

      if (
        frameSummary.some((f) =>
          typeof f.url === "string" &&
          f.url.includes("challenges.cloudflare.com")
        )
      ) {
        log(
          "[VERIFICATION NOTICE] A Cloudflare verification frame is present. " +
          "This node does not solve or bypass verification. Use an approved " +
          "interactive verification flow or contact the site operator about automation access."
        );
      }

      nextDiagnosticAt = Date.now() + 20_000;
    }

    await page.waitForTimeout(1_000).catch(() => {});
  }

  await dumpPageDiagnostics(
    page,
    "GENERATOR API DISCOVERY TIMEOUT"
  );

  throw new Error(
    "Could not find root.generateText/root.generateImage within " +
    `${Math.round(timeoutMs / 1000)} seconds. See PAGE SNAPSHOT, FRAME SNAPSHOT, ` +
    "REQUEST FAILED and HTTP ERROR log entries for the exact iframe failure."
  );
}

// ============================================================
// START HEADED CHROMIUM UNDER XVFB
// ============================================================

async function startBrowser() {
  await fs.mkdir(PROFILE_DIR, {
    recursive: true
  });

  log(
    "Launching headed Chromium under Xvfb with persistent profile",
    PROFILE_DIR
  );

  browserContext = await chromium.launchPersistentContext(
    PROFILE_DIR,
    {
      headless: false,

      viewport: {
        width: 1365,
        height: 900
      },

      locale: "en-US",

      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    }
  );

  currentPage =
    browserContext.pages()[0] ||
    await browserContext.newPage();

  attachPageDiagnostics(currentPage);

  await currentPage.exposeFunction(
    "__cloudflareEmitChunk",
    (payload) => {
      if (
        !payload ||
        typeof payload.taskId !== "string" ||
        typeof payload.text !== "string" ||
        payload.text.length > 64_000
      ) {
        return;
      }

      send({
        type: "chunk",
        taskId: payload.taskId,
        text: payload.text
      });
    }
  );

  await currentPage.goto(PERCHANCE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });

  log("Opened", PERCHANCE_URL);

  await continuePastPerchanceWarning(currentPage);

  await currentPage.waitForTimeout(2_500);

  await dumpPageDiagnostics(
    currentPage,
    "POST-WARNING DIAGNOSTIC"
  );

  generatorFrame = await locateGeneratorFrame(currentPage);

  log(
    "Found Perchance generation API in frame:",
    generatorFrame.url()
  );
}

// ============================================================
// GENERATION JOB HANDLER
// ============================================================

async function runJob(job) {
  if (
    !job ||
    typeof job.taskId !== "string" ||
    activeJobs.has(job.taskId)
  ) {
    return;
  }

  activeJobs.add(job.taskId);

  send({
    type: "started",
    taskId: job.taskId
  });

  try {
    if (
      !generatorFrame ||
      generatorFrame.isDetached()
    ) {
      generatorFrame = await locateGeneratorFrame(
        currentPage,
        30_000
      );
    }

    const result = await generatorFrame.evaluate(
      async (input) => {
        let api = window.root;

        if (!api) {
          try {
            api = window.eval(
              "typeof root !== 'undefined' ? root : null"
            );
          } catch {}
        }

        if (!api) {
          throw new Error(
            "Perchance root API disappeared."
          );
        }

        // IMAGE GENERATION
        if (input.mode === "image") {
          const generated = await api.generateImage(
            input.prompt,
            {
              resolution: input.resolution
            }
          );

          const dataUrl = generated?.dataUrl;

          if (
            typeof dataUrl !== "string" ||
            !dataUrl.startsWith("data:image/")
          ) {
            throw new Error(
              "Perchance image generation returned no image data URL."
            );
          }

          return {
            response: dataUrl
          };
        }

        // TEXT GENERATION
        if (input.mode === "text") {
          let previousFullText = "";
          let appendCompatible = true;

          const generated = await api.generateText({
            instruction: input.prompt,

            onChunk: (chunkData) => {
              const fullText =
                chunkData &&
                typeof chunkData.fullTextSoFar === "string"
                  ? chunkData.fullTextSoFar
                  : null;

              if (
                fullText === null ||
                !appendCompatible
              ) {
                return;
              }

              if (
                !fullText.startsWith(previousFullText)
              ) {
                appendCompatible = false;
                return;
              }

              const delta = fullText.slice(
                previousFullText.length
              );

              previousFullText = fullText;

              if (delta) {
                window.__cloudflareEmitChunk({
                  taskId: input.taskId,
                  text: delta
                });
              }
            }
          });

          const text = generated?.text;

          if (
            typeof text !== "string" ||
            !text.length
          ) {
            throw new Error(
              "Perchance text generation returned an empty result."
            );
          }

          return {
            response: text
          };
        }

        throw new Error(
          `Unsupported job mode: ${input.mode}`
        );
      },
      {
        taskId: job.taskId,
        mode: job.mode,
        prompt: job.prompt,
        resolution: job.resolution
      }
    );

    if (
      job.mode === "image" &&
      result.response.length > MAX_IMAGE_DATA_URL_CHARS
    ) {
      throw new Error(
        "Image result exceeds the configured 6 MB Cloudflare storage limit."
      );
    }

    send({
      type: "result",
      taskId: job.taskId,
      response: result.response
    });

    log(
      "Job completed:",
      job.taskId,
      job.mode
    );

  } catch (error) {
    const message = errorText(error);

    log(
      "Job failed:",
      job.taskId,
      message
    );

    send({
      type: "error",
      taskId: job.taskId,
      error: message
    });

  } finally {
    activeJobs.delete(job.taskId);
  }
}

// ============================================================
// CLOUDFLARE WEBSOCKET CONNECTION
// ============================================================

function openCloudflareSocket() {
  return new Promise((resolve, reject) => {
    const url = new URL(CF_WS_URL);

    url.searchParams.set("role", "node");

    const ws = new WebSocket(
      url.toString(),
      {
        handshakeTimeout: 30_000
      }
    );

    socket = ws;

    let settled = false;

    ws.on("open", () => {
      log("Connected to Cloudflare; authenticating.");

      ws.send(JSON.stringify({
        type: "auth",
        token: NODE_TOKEN
      }));
    });

    ws.on("message", (buffer) => {
      const raw = buffer.toString();

      if (raw === "pong") return;

      let message;

      try {
        message = JSON.parse(raw);
      } catch {
        log("Ignoring non-JSON Cloudflare message.");
        return;
      }

      if (message.type === "auth_ok") {
        log("Cloudflare authentication accepted.");

        ws.send(JSON.stringify({
          type: "register",
          nodeId: NODE_ID,
          textSlots: TEXT_SLOTS,
          imageSlots: IMAGE_SLOTS
        }));

        return;
      }

      if (message.type === "node_ready") {
        log(
          "Registered with Cloudflare:",
          message
        );

        if (!settled) {
          settled = true;
          resolve(ws);
        }

        return;
      }

      if (message.type === "job") {
        void runJob(message);
        return;
      }

      if (message.type === "error") {
        log("Cloudflare error:", message.error);

        if (!settled) {
          settled = true;

          reject(
            new Error(
              `Cloudflare rejected node registration: ${
                message.error || "unknown error"
              }`
            )
          );
        }
      }
    });

    ws.on("close", (code, reason) => {
      log(
        "Cloudflare socket closed",
        code,
        reason.toString()
      );

      if (!settled) {
        settled = true;

        reject(
          new Error(
            `WebSocket closed before registration (${code})`
          )
        );
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

// ============================================================
// MAIN NODE LOOP
// ============================================================

async function main() {
  await networkDiagnostics();

  while (true) {
    let heartbeat;

    try {
      await startBrowser();

      await openCloudflareSocket();

      log(
        `Node online. Capacity: ${TEXT_SLOTS} text + ${IMAGE_SLOTS} image.`
      );

      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, HEARTBEAT_MS);

      await new Promise((resolve) => {
        socket.once("close", resolve);
        currentPage.once("close", resolve);
        currentPage.once("crash", resolve);
      });

    } catch (error) {
      log(
        "Node cycle ended:",
        errorText(error)
      );

    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
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
    }

    log(
      "Restarting browser/node connection in 5 seconds."
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 5_000)
    );
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

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
  log("Fatal node error:", errorText(error));
  process.exit(1);
});
