# NVIDIA NIM OpenAI API Proxy

A lightweight Cloudflare Worker that forwards supported OpenAI-compatible API requests to NVIDIA NIM. It passes response bodies through without buffering, including server-sent events (SSE).

## Supported endpoints

- `GET /health` — health check; no authentication required
- `GET /v1/models`
- `POST /v1/chat/completions` — supports `stream: true`
- `POST /v1/completions`
- `POST /v1/embeddings`

All other paths are rejected. The proxy does not provide an admin UI, admin API, session management, or KV-backed state.

## Configuration

Set `NIM_API_KEY` as a Cloudflare Worker secret to use a shared upstream key:

```sh
npx wrangler secret put NIM_API_KEY
```

When set, the Worker uses this key for every upstream request and replaces any client-supplied `Authorization` header. Clients do not need their own NVIDIA key in this mode. **Anyone who can reach a publicly accessible Worker can use your NIM quota.** Protect a shared-key deployment with Cloudflare Access or another access-control layer, or keep the Worker private.

If `NIM_API_KEY` is not set, clients must provide their NVIDIA NIM key in the `Authorization: Bearer <key>` request header.

Optional environment variables:

- `NIM_BASE_URL` — upstream HTTPS origin; defaults to `https://integrate.api.nvidia.com`. Only an origin is accepted (no path, query, or credentials).
- `ALLOWED_ORIGIN` — restricts browser CORS to this origin. If unset, CORS allows all origins; CORS is not authentication.

Configure these variables in the Cloudflare Worker settings. For local development, create an untracked `.dev.vars` file:

```dotenv
NIM_API_KEY=your-nvidia-nim-key
# NIM_BASE_URL=https://integrate.api.nvidia.com
# ALLOWED_ORIGIN=https://your-app.example
```

## Deploy with Cloudflare Workers Builds

Connect this GitHub repository in Cloudflare Workers Builds and select `main` as the production branch. Configure the deployment command as `npm run deploy`; Cloudflare then builds and deploys the Worker on pushes to that branch. GitHub Actions runs type checks and tests only and does not need Cloudflare deployment credentials.

For a one-time local deployment, install Node.js 22 or later, run `npm ci`, authenticate with `npx wrangler login`, then run:

```sh
npm run deploy
```

## Use with the OpenAI SDK

Set the SDK base URL to your Worker URL. When the Worker has a shared `NIM_API_KEY`, the SDK still requires a non-empty `apiKey`, but the Worker replaces that value with its configured secret. Otherwise, provide your own NVIDIA NIM key.

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<worker-name>.<account>.workers.dev/v1",
  apiKey: process.env.NIM_API_KEY ?? "placeholder",
});

const stream = await client.chat.completions.create({
  model: "meta/llama-3.1-8b-instruct",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Use model names and request fields supported by NVIDIA NIM. `GET /v1/models` lists the models available upstream.

## Local development and checks

```sh
npm ci
npm run dev
npm run typecheck
npm test
```

Check a deployed Worker with `GET /health`. This confirms the Worker is responding; it does not verify that NVIDIA NIM credentials or model requests are working.
