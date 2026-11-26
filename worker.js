import { DurableObject } from "cloudflare:workers";

const RESOLUTIONS = new Set(["512x512", "768x512", "512x768", "768x768"]);
const MAX_PROMPT_CHARS = 24_000;
const MAX_RESULT_CHARS = 6_000_000; // Keep one SQLite row comfortably below Cloudflare's 8 MiB row limit.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "perchance-cloud-pool" });
    }

    if (url.pathname !== "/ws") {
      return new Response("Use /ws?role=node or /ws?role=client; /health is also available.", {
        status: 404,
      });
    }

    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const role = url.searchParams.get("role");
    if (role !== "node" && role !== "client") {
      return new Response("role must be node or client", { status: 400 });
    }

    const id = env.HUB.idFromName("global-pool");
    return env.HUB.get(id).fetch(request);
  },
};

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        resolution TEXT NOT NULL,
        status TEXT NOT NULL,
        node_id TEXT,
        response TEXT,
        error TEXT,
        sent_to_provider INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS jobs_request_idx ON jobs(request_id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS jobs_node_idx ON jobs(node_id, status, mode)");

    // Application-level text ping/pong is handled by the runtime without waking the DO.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({
      role,
      authenticated: false,
      clientId: role === "client" ? crypto.randomUUID() : null,
      connectedAt: Date.now(),
      registered: false,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    if (typeof rawMessage !== "string") {
      ws.close(1003, "Text messages only");
      return;
    }

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      this.safeSend(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    let session = ws.deserializeAttachment() || {};

    if (message.type === "auth") {
      const expected = session.role === "node" ? this.env.NODE_TOKEN : this.env.CLIENT_TOKEN;
      if (!expected || typeof message.token !== "string" || message.token !== expected) {
        ws.close(1008, "Invalid token");
        return;
      }
      session = { ...session, authenticated: true, authenticatedAt: Date.now() };
      ws.serializeAttachment(session);
      this.safeSend(ws, { type: "auth_ok", role: session.role, clientId: session.clientId });
      return;
    }

    if (!session.authenticated) {
      ws.close(1008, "Authenticate first");
      return;
    }

    if (message.type === "register" && session.role === "node") {
      const nodeId = String(message.nodeId || "").slice(0, 100);
      if (!nodeId) {
        this.safeSend(ws, { type: "error", error: "nodeId is required" });
        return;
      }
      const textSlots = this.clampInt(message.textSlots, 0, 4, 2);
      const imageSlots = this.clampInt(message.imageSlots, 0, 2, 1);
      session = {
        ...session,
        nodeId,
        textSlots,
        imageSlots,
        registered: true,
        lastRegisterAt: Date.now(),
      };

      // A reconnect with the same node ID replaces the previous socket.
      for (const oldSocket of this.ctx.getWebSockets("node")) {
        if (oldSocket === ws) continue;
        const oldSession = oldSocket.deserializeAttachment() || {};
        if (oldSession.nodeId === nodeId) {
          try { oldSocket.close(1012, "Replaced by a newer connection"); } catch {}
        }
      }

      ws.serializeAttachment(session);
      this.safeSend(ws, { type: "node_ready", nodeId, textSlots, imageSlots });
      await this.dispatch();
      return;
    }

    if (session.role === "client" && message.type === "submit") {
      await this.submit(ws, session, message);
      return;
    }

    if (session.role === "client" && message.type === "get_request") {
      this.sendRequestSnapshot(ws, String(message.requestId || ""));
      return;
    }

    if (session.role === "node") {
      await this.handleNodeMessage(ws, session, message);
      return;
    }

    this.safeSend(ws, { type: "error", error: "Unsupported message" });
  }

  async submit(ws, session, message) {
    const mode = message.mode;
    const prompt = typeof message.prompt === "string" ? message.prompt : "";
    const resolution = RESOLUTIONS.has(message.resolution) ? message.resolution : "512x768";

    if (!new Set(["text", "image", "both"]).has(mode)) {
      this.safeSend(ws, { type: "error", error: "mode must be text, image, or both" });
      return;
    }
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      this.safeSend(ws, { type: "error", error: `Prompt must contain 1-${MAX_PROMPT_CHARS} characters` });
      return;
    }

    const requestId = crypto.randomUUID();
    const modes = mode === "both" ? ["text", "image"] : [mode];
    const now = Date.now();

    // Keep the small free-tier SQLite database bounded. Active work is never pruned.
    this.sql.exec(
      "DELETE FROM jobs WHERE status IN ('complete','failed','uncertain') AND updated_at < ?",
      now - 7 * 24 * 60 * 60 * 1000,
    );
    const taskIds = [];

    for (const taskMode of modes) {
      const taskId = crypto.randomUUID();
      taskIds.push(taskId);
      this.sql.exec(
        `INSERT INTO jobs
          (id, request_id, client_id, mode, prompt, resolution, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        taskId, requestId, session.clientId, taskMode, prompt, resolution, now, now,
      );
    }

    this.safeSend(ws, { type: "accepted", requestId, taskIds, modes, status: "queued" });
    await this.dispatch();
  }

  async handleNodeMessage(ws, session, message) {
    if (!session.registered || !session.nodeId) {
      this.safeSend(ws, { type: "error", error: "Register this node first" });
      return;
    }

    const taskId = String(message.taskId || "");
    if (message.type === "started") {
      this.sql.exec(
        "UPDATE jobs SET status='running', sent_to_provider=1, updated_at=? WHERE id=? AND node_id=? AND status='assigned'",
        Date.now(), taskId, session.nodeId,
      );
      return;
    }

    if (message.type === "chunk") {
      const row = this.sql.exec(
        "SELECT request_id, client_id, mode, status FROM jobs WHERE id=? AND node_id=?",
        taskId, session.nodeId,
      ).toArray()[0];
      if (!row || row.status !== "running") return;
      const text = typeof message.text === "string" ? message.text : "";
      if (!text || text.length > 64_000) return;
      this.sendToClient(row.client_id, {
        type: "chunk",
        requestId: row.request_id,
        taskId,
        mode: row.mode,
        text,
      });
      return;
    }

    if (message.type === "result") {
      const response = typeof message.response === "string" ? message.response : "";
      if (!response || response.length > MAX_RESULT_CHARS) {
        await this.failJob(taskId, session.nodeId, "Result was empty or exceeded the 6 MB storage safety limit.");
        return;
      }
      const row = this.sql.exec(
        "SELECT request_id, client_id, mode FROM jobs WHERE id=? AND node_id=?",
        taskId, session.nodeId,
      ).toArray()[0];
      if (!row) return;
      this.sql.exec(
        "UPDATE jobs SET status='complete', response=?, updated_at=? WHERE id=? AND node_id=?",
        response, Date.now(), taskId, session.nodeId,
      );
      this.sendToClient(row.client_id, {
        type: "result",
        requestId: row.request_id,
        taskId,
        mode: row.mode,
        response,
      });
      this.notifyRequestFinished(row.request_id, row.client_id);
      await this.dispatch();
      return;
    }

    if (message.type === "error") {
      await this.failJob(taskId, session.nodeId, String(message.error || "Node generation failed").slice(0, 2000));
      await this.dispatch();
      return;
    }

    if (message.type === "heartbeat") {
      this.safeSend(ws, { type: "heartbeat_ok", at: Date.now() });
      return;
    }

    this.safeSend(ws, { type: "error", error: "Unknown node message" });
  }

  async failJob(taskId, nodeId, error) {
    const row = this.sql.exec(
      "SELECT request_id, client_id, mode FROM jobs WHERE id=? AND node_id=?",
      taskId, nodeId,
    ).toArray()[0];
    if (!row) return;
    this.sql.exec(
      "UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=? AND node_id=?",
      error, Date.now(), taskId, nodeId,
    );
    this.sendToClient(row.client_id, {
      type: "task_error",
      requestId: row.request_id,
      taskId,
      mode: row.mode,
      error,
    });
    this.notifyRequestFinished(row.request_id, row.client_id);
  }

  async dispatch() {
    const queued = this.sql.exec(
      "SELECT id, request_id, mode, prompt, resolution FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 100",
    ).toArray();
    if (!queued.length) return;

    const nodes = this.ctx.getWebSockets("node").map((ws) => ({
      ws,
      session: ws.deserializeAttachment() || {},
    })).filter(({ ws, session }) =>
      ws.readyState === WebSocket.OPEN && session.authenticated && session.registered && session.nodeId,
    );

    for (const job of queued) {
      const candidates = [];
      for (const node of nodes) {
        const capacity = job.mode === "text" ? node.session.textSlots : node.session.imageSlots;
        if (!capacity) continue;
        const count = this.sql.exec(
          "SELECT COUNT(*) AS n FROM jobs WHERE node_id=? AND mode=? AND status IN ('assigned','running')",
          node.session.nodeId, job.mode,
        ).toArray()[0]?.n ?? 0;
        if (count < capacity) candidates.push({ ...node, count, capacity });
      }
      if (!candidates.length) continue;

      candidates.sort((a, b) => (a.count / a.capacity) - (b.count / b.capacity));
      const chosen = candidates[0];
      this.sql.exec(
        "UPDATE jobs SET status='assigned', node_id=?, updated_at=? WHERE id=? AND status='queued'",
        chosen.session.nodeId, Date.now(), job.id,
      );

      const sent = this.safeSend(chosen.ws, {
        type: "job",
        taskId: job.id,
        requestId: job.request_id,
        mode: job.mode,
        prompt: job.prompt,
        resolution: job.resolution,
      });
      if (!sent) {
        this.sql.exec(
          "UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE id=? AND status='assigned'",
          Date.now(), job.id,
        );
      }
    }
  }

  notifyRequestFinished(requestId, clientId) {
    const rows = this.sql.exec(
      "SELECT mode, status, error FROM jobs WHERE request_id=?",
      requestId,
    ).toArray();
    if (!rows.length || rows.some((row) => ["queued", "assigned", "running"].includes(row.status))) return;
    const status = rows.every((row) => row.status === "complete") ? "complete" : "partial_failure";
    this.sendToClient(clientId, { type: "request_done", requestId, status, tasks: rows });
  }

  sendRequestSnapshot(ws, requestId) {
    if (!requestId || requestId.length > 100) return;
    const rows = this.sql.exec(
      "SELECT id AS taskId, mode, status, response, error FROM jobs WHERE request_id=?",
      requestId,
    ).toArray();
    if (!rows.length) {
      this.safeSend(ws, { type: "request_state", requestId, found: false });
      return;
    }
    this.safeSend(ws, { type: "request_state", requestId, found: true, tasks: rows });
  }

  sendToClient(clientId, payload) {
    for (const socket of this.ctx.getWebSockets("client")) {
      const session = socket.deserializeAttachment() || {};
      if (session.authenticated && session.clientId === clientId) this.safeSend(socket, payload);
    }
  }

  safeSend(ws, payload) {
    try {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  async webSocketClose(ws, code, reason) {
    const session = ws.deserializeAttachment() || {};
    if (session.role !== "node" || !session.nodeId) return;

    // If this is an old socket replaced by a reconnect using the same node ID,
    // do not disturb work assigned to the replacement connection.
    const replacementStillOnline = this.ctx.getWebSockets("node").some((candidate) => {
      if (candidate === ws || candidate.readyState !== WebSocket.OPEN) return false;
      const candidateSession = candidate.deserializeAttachment() || {};
      return candidateSession.authenticated && candidateSession.registered && candidateSession.nodeId === session.nodeId;
    });
    if (replacementStillOnline) return;

    // Work that was assigned but not started can safely return to the queue.
    this.sql.exec(
      "UPDATE jobs SET status='queued', node_id=NULL, updated_at=? WHERE node_id=? AND status='assigned'",
      Date.now(), session.nodeId,
    );

    // Work marked running may already have reached Perchance. Do not duplicate it automatically.
    const uncertain = this.sql.exec(
      "SELECT id, request_id, client_id, mode FROM jobs WHERE node_id=? AND status='running'",
      session.nodeId,
    ).toArray();
    for (const job of uncertain) {
      this.sql.exec(
        "UPDATE jobs SET status='uncertain', error='Node disconnected after generation started; not retried automatically.', updated_at=? WHERE id=?",
        Date.now(), job.id,
      );
      this.sendToClient(job.client_id, {
        type: "task_error",
        requestId: job.request_id,
        taskId: job.id,
        mode: job.mode,
        error: "Node disconnected after generation started. This job is marked uncertain to avoid accidental duplicate generation.",
      });
      this.notifyRequestFinished(job.request_id, job.client_id);
    }

    await this.dispatch();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, "WebSocket error");
  }
}
