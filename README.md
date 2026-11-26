# Perchance Cloud Pool (starter)

This project replaces the local Python bridge with a Cloudflare Durable Object WebSocket hub and a headless Playwright node. The node keeps a Perchance page open and calls `root.generateText()` / `root.generateImage()` in the page context.

## What it includes

- Cloudflare Worker at `/health` and `/ws?role=node|client`.
- SQLite-backed Durable Object queue and least-loaded compatible-node dispatcher.
- Per-node capacity of 2 text jobs and 1 image job by default.
- A headless Chromium node with a persistent browser profile under `/data/profile`.
- Text delta forwarding and final text/image results.
- Example Node.js client.
- GitHub Actions workflow that builds a public-ready `linux/amd64` image for GHCR.

## Important scope and limitations

1. This is a starter implementation. Test it with one node and your Perchance account before adding more nodes or exposing the client token to other people.
2. The Perchance page must expose `root.generateText` and `root.generateImage` in one of its frames. The node searches every frame for those methods at startup. If Perchance changes its site internals, the node may need an update.
3. The old Tampermonkey communicator is not used in this design. The Playwright agent replaces its local HTTP bridge. The keep-alive script's visibility spoofing / synthetic internal keep-alive messages are intentionally not included.
4. A page/browser crash causes the node to reconnect. Jobs that were already marked running are marked `uncertain` instead of being replayed automatically, to avoid accidental duplicate generations.
5. Image results travel as data URLs over WebSocket. The code rejects results above 6 MB. The Durable Object's incoming WebSocket message limit is 32 MiB and SQLite rows are limited to 8 MiB, so the image-result cap is kept at 6 MB.
6. A client should keep its WebSocket open while a generation is running. Completed results are saved in the Durable Object; send `{ "type": "get_request", "requestId": "..." }` after reconnecting to retrieve saved task states/results.
7. This does not bypass Perchance's service limits, account rules, inactivity controls, or generation limits. Use it only within the site's permitted usage.

## A. Deploy the Cloudflare hub

Install Node.js 22+ on your computer, then:

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put NODE_TOKEN
npx wrangler secret put CLIENT_TOKEN
npx wrangler deploy
```

Use two different long random secrets. Save them securely; do not put them in this repository. Keep `CLIENT_TOKEN` on a trusted backend—never put the shared token in JavaScript shipped to a public website. Deploy prints a URL such as `https://perchance-cloud-pool.<your-subdomain>.workers.dev`.

The WebSocket URL is that URL with `/ws`, for example:

`wss://perchance-cloud-pool.<your-subdomain>.workers.dev/ws`

The health check is:

`https://perchance-cloud-pool.<your-subdomain>.workers.dev/health`

## B. Publish the browser-node image

1. Create a GitHub repository and upload the contents of this project.
2. Make sure the default branch is named `main`.
3. In GitHub, open **Actions** and enable workflows if asked.
4. Push the repository. The included workflow builds `node/Dockerfile` and pushes the image to GitHub Container Registry.
5. Open the repository owner's GitHub profile → **Packages** → `perchance-node` → **Package settings** → change visibility to **Public**. Altare can then pull the image without registry credentials.
6. The image name is `ghcr.io/OWNER/REPOSITORY:latest` (all lowercase). Use the exact name shown in the Actions build log/package page.

## C. Create the Altare Docker App

1. Sign in at https://console.altare.gg.
2. Open **Apps** → **New app** → **Docker image**.
3. Enter the public GHCR image from section B and select **Check**.
4. Leave **Port** empty: this node makes an outbound WebSocket connection and does not host an inbound API.
5. Set the data folder to `/data` so the persistent Playwright profile survives redeploys.
6. Allocate resources from your team's shared pool. Start with approximately 2–3 GiB RAM and 50–75% CPU for one browser node if the console allows that split; leave the rest unallocated until the first test works.
7. Add these environment variables:

```text
CF_WS_URL=wss://YOUR-WORKER.workers.dev/ws
NODE_TOKEN=THE_NODE_TOKEN_YOU_SET_IN_CLOUDFLARE
NODE_ID=altare-node-1
PERCHANCE_URL=https://perchance.org/fu677q3rr4
TEXT_SLOTS=2
IMAGE_SLOTS=1
PROFILE_DIR=/data/profile
```

8. Create and start the app. Check its logs. Expected messages include `Found Perchance generation API in frame` and `Registered with Cloudflare`.

## D. Test with a client

On a computer with Node.js 22+:

```bash
cd examples
npm init -y
npm install ws
```

Set the environment variables:

```bash
export CF_WS_URL="wss://YOUR-WORKER.workers.dev/ws"
export CLIENT_TOKEN="THE_CLIENT_TOKEN_YOU_SET_IN_CLOUDFLARE"
export MODE="text"
export PROMPT="Write a short fantasy story about a lighthouse."
node client.mjs
```

For an image:

```bash
MODE=image PROMPT="A watercolor lighthouse on a stormy coast" RESOLUTION=512x512 node client.mjs
```

For text + image:

```bash
MODE=both PROMPT="A dragon sleeping in an ancient library" node client.mjs
```

## E. Add more nodes

Create another Altare Docker App using the same image. Give it a different `NODE_ID` such as `altare-node-2`, and its own allocation from the same team pool. It can use the same `NODE_TOKEN`. Do not assume every server receives 6 GB / 1.5 CPU: the free package is shared across the entire Altare team.

## WebSocket protocol

Client authenticates:

```json
{"type":"auth","token":"CLIENT_TOKEN"}
```

Client submits:

```json
{"type":"submit","mode":"text","prompt":"...","resolution":"512x768"}
```

Supported modes: `text`, `image`, `both`.

Client events: `accepted`, `chunk`, `result`, `task_error`, `request_done`, `request_state`.

The browser node authenticates, registers its slot counts, receives `job` messages, and responds with `started`, `chunk`, `result`, or `error`.
