# Perchance Cloud Pool — dashboard deployment

This project replaces the local Python bridge with a Cloudflare Worker + SQLite-backed Durable Object and a headless Playwright browser node.

**You do not need to run `wrangler login` or deploy from your own terminal.** Use the Cloudflare dashboard's GitHub integration to build and deploy the Worker. Cloudflare Workers Builds runs the deploy command for you.

## What the project contains

- `cloudflare/`: Worker API, Durable Object scheduler, and `wrangler.toml` configuration.
- `node/`: headless Chromium + Playwright browser node and Dockerfile.
- `.github/workflows/publish-node.yml`: builds the node Docker image and publishes it to GitHub Container Registry (GHCR).
- `examples/`: a Node.js example client.

The first release is intentionally for **one node**. Validate the Perchance page API and a complete text/image round trip before creating more nodes.

## 1. Upload this project to GitHub

1. Download and extract the ZIP.
2. Create a GitHub repository named `perchance-cloud-pool` (lowercase is easiest). Public or private is fine for Cloudflare; the container package will be made public later so Altare can pull it without registry credentials.
3. In the new repo, choose **Add file → Upload files**.
4. Upload the *contents* of the extracted `perchance-cloud-pool` folder, preserving the folder structure. Include the hidden `.github` folder.
5. Commit the upload to the `main` branch.

Do not upload only the ZIP file. The repository root should contain `.github`, `cloudflare`, `node`, `examples`, and `.gitignore`.

## 2. Deploy Cloudflare without Wrangler login

1. Sign in to the Cloudflare dashboard: <https://dash.cloudflare.com/>.
2. Open **Workers & Pages** → **Create application**.
3. Choose the GitHub repository option and authorize Cloudflare's GitHub integration. This is a one-time GitHub repository connection; it is not `wrangler login`.
4. Select the `perchance-cloud-pool` repository.
5. Configure the Worker build:
   - Worker name: `perchance-cloud-pool`
   - Root directory: `cloudflare`
   - Build command: leave blank
   - Deploy command: `npx wrangler deploy`
   - Branch: `main`
6. Save and deploy.

The `cloudflare/wrangler.toml` file already defines the Worker entry point, the `HUB` Durable Object binding, and its SQLite migration. You do not need to create a Durable Object manually in the dashboard. Workers Builds runs Wrangler in Cloudflare's build environment, so no local Wrangler OAuth login is needed.

If the dashboard creates a Worker before asking for the repository, make sure its name is exactly `perchance-cloud-pool`, matching the `name` in `cloudflare/wrangler.toml`.

## 3. Add the two Worker secrets in the dashboard

Generate two different long random values using a password manager (at least 32 random bytes each). Keep them private.

In Cloudflare:

1. Open **Workers & Pages** → `perchance-cloud-pool` → **Settings**.
2. Find **Variables and Secrets** → **Add**.
3. Add a secret named `NODE_TOKEN` and paste the first random value.
4. Add a secret named `CLIENT_TOKEN` and paste the second random value.
5. Select **Deploy** to apply them.

Do not put either token in GitHub files. `NODE_TOKEN` is configured only on the Altare node. Keep `CLIENT_TOKEN` on trusted client backends; do not put it in JavaScript served to public visitors.

## 4. Check Cloudflare

Open:

`https://perchance-cloud-pool.YOUR-SUBDOMAIN.workers.dev/health`

Use the exact `workers.dev` hostname shown on your Worker Overview page. Expected response:

```json
{"ok":true,"service":"perchance-cloud-pool"}
```

The WebSocket address is the same hostname with `wss://` and `/ws`:

`wss://perchance-cloud-pool.YOUR-SUBDOMAIN.workers.dev/ws`

## 5. Build and publish the browser-node image

The GitHub Actions workflow should run automatically after the first commit because the upload includes `node/` and `.github/workflows/publish-node.yml`.

1. Open the GitHub repo's **Actions** tab. Enable Actions if GitHub asks.
2. Wait for **Build and publish Perchance browser node** to complete successfully. If needed, use **Run workflow**.
3. Open the repository owner's GitHub profile → **Packages** → `perchance-cloud-pool` → **Package settings**.
4. Change the container package visibility to **Public**.

The image name will be:

`ghcr.io/YOUR_GITHUB_USERNAME/perchance-cloud-pool:latest`

Use lowercase for the GitHub username and repository in the image reference.

## 6. Create one Altare node

1. Sign in at <https://console.altare.gg/>.
2. Open **Apps** → **New app** → **Docker image**.
3. Enter `ghcr.io/YOUR_GITHUB_USERNAME/perchance-cloud-pool:latest`, then choose **Check**.
4. Leave **Port** empty: this worker only makes an outbound WebSocket connection.
5. Set **Data folder** to `/data` so the Playwright browser profile persists across image updates.
6. Start with about 3 GB memory, 75% CPU, and 5 GB disk if those allocations are available. Altare's Always Free resources are shared across the whole team; its published pool is 6 GB memory, 150% CPU, 10 GB disk, and four server slots. These are shared limits, not per-app allocations.
7. Add these environment variables:

```text
CF_WS_URL=wss://perchance-cloud-pool.YOUR-SUBDOMAIN.workers.dev/ws
NODE_TOKEN=THE_NODE_TOKEN_SECRET_FROM_CLOUDFLARE
NODE_ID=altare-node-1
PERCHANCE_URL=https://perchance.org/fu677q3rr4
TEXT_SLOTS=2
IMAGE_SLOTS=1
PROFILE_DIR=/data/profile
```

8. Create/start the app and open its logs.

Expected log messages include:

```text
Opened https://perchance.org/fu677q3rr4
Found Perchance generation API in frame:
Connected to Cloudflare; authenticating.
Registered with Cloudflare:
Node online. Capacity: 2 text + 1 image.
```

If the node cannot find the Perchance generation API, do not add more nodes yet; inspect that error first. The site may have changed its internal API or be showing a browser challenge.

## 7. Test a request from your computer

You need Node.js 22+ on your computer. Open a terminal in `examples` and run:

```bash
npm init -y
npm install ws
```

PowerShell:

```powershell
$env:CF_WS_URL="wss://perchance-cloud-pool.YOUR-SUBDOMAIN.workers.dev/ws"
$env:CLIENT_TOKEN="YOUR_CLIENT_TOKEN_SECRET"
$env:MODE="text"
$env:PROMPT="Write a short fantasy story about a lighthouse."
node .\client.mjs
```

For image generation:

```powershell
$env:MODE="image"
$env:PROMPT="A watercolor lighthouse on a stormy coast"
$env:RESOLUTION="512x512"
node .\client.mjs
```

For text and image together:

```powershell
$env:MODE="both"
node .\client.mjs
```

On macOS/Linux, set the same environment variables with `export NAME="value"` before running `node client.mjs`.

## 8. Add more nodes only after the first one works

Create a second Altare Docker App with the same public image and all the same settings, but use a different node ID, for example `altare-node-2`. Each additional node consumes more of the same team resource pool. Do not assume each one receives the full free allowance.

## Important limitations

- This is a starter implementation; validate with one node before relying on it.
- Perchance's `root.generateText()` and `root.generateImage()` must be available in a frame on the loaded page. The agent searches the page's frames for those methods.
- The node invokes Perchance through a real headless browser. It does not run generation inside Cloudflare.
- The old Tampermonkey Local Bridge Communicator is not used. The node speaks WebSocket to Cloudflare instead.
- The old synthetic keep-alive and visibility-spoofing code is not included. The browser keeps a real page open; this does not bypass Perchance service limits, account rules, inactivity controls, or generation limits.
- If a node disconnects after starting a job, the hub marks the job uncertain rather than blindly replaying it, to avoid duplicate generations.
- Keep `CLIENT_TOKEN` off public websites. Use a trusted backend to connect clients to the Cloudflare WebSocket API.
