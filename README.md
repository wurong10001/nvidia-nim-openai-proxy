# NVIDIA NIM → OpenAI API Proxy（Cloudflare Worker）

将 OpenAI SDK 的请求通过 Cloudflare 全球边缘网络转发到 NVIDIA NIM。NIM 提供 OpenAI 兼容接口，因此代理保留请求/响应格式，并直接流式转发 SSE，不缓存生成结果。

## 支持接口

- `GET /v1/models`
- `POST /v1/chat/completions`（包含流式 `stream: true`）
- `POST /v1/completions`
- `POST /v1/embeddings`
- `GET /health`（不需要认证）

此 Worker 负责边缘代理与密钥隔离，不会改变模型能力或绕过 NIM 的限流、计费和区域限制。实际延迟取决于客户端、Cloudflare 边缘节点及 NIM 上游网络。

## 部署

1. 安装 Node.js 20+，然后运行 `npm ci`。
2. 登录 Cloudflare：`npx wrangler login`。
3. （可选）设置上游 NIM API Key：`npx wrangler secret put NIM_API_KEY`。
4. 部署：`npm run deploy`。

密钥解析规则：设置了 `NIM_API_KEY` 时，所有请求共用该 key 访问 NIM，客户端无需携带密钥——此时 Worker 地址本身就是凭证，切勿公开；未设置时，客户端必须在请求头 `Authorization: Bearer <nim-key>` 中自带 NIM key。不要将任何密钥提交到 Git。

可选配置：

- `NIM_BASE_URL`：NIM 上游 HTTPS origin，默认 `https://integrate.api.nvidia.com`。只能配置 origin，不可附加路径、查询参数或凭证。
- `ALLOWED_ORIGIN`：限制浏览器 CORS 来源；未配置时返回 `Access-Control-Allow-Origin: *`。此设置不是 API 认证的替代品。
- KV namespace：管理面板需要 `ADMIN_KV` 与 `ADMIN_TEMP_KV` 两个 KV 绑定。部署前先创建（`npx wrangler kv namespace create ADMIN_KV` 与 `ADMIN_TEMP_KV`），把输出的 ID 填入 `wrangler.toml` 中对应的 `id` / `preview_id`。

## 使用

将 OpenAI SDK 的 `baseURL` 指向 Worker 地址，并按上面的密钥解析规则提供 API Key：

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<worker-name>.<account>.workers.dev/v1",
  // 部署了 NIM_API_KEY 时此处可填任意占位值；否则填入客户端自己的 NIM key
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

模型名称及请求字段应使用 NVIDIA NIM 支持的值。可通过 `/v1/models` 查询上游可用模型。

## 管理面板

Worker 内置一组管理端点（依赖上述两个 KV namespace）：

- `GET /op/admin`：面板页面
- `POST /op/api/set-admin-pw`：首次设置管理员密码（已设置后返回 409）
- `POST /op/api/login`：登录，返回会话 token
- `POST /op/api/change-admin-pw`：修改密码（需 `X-Admin-Token` 头）
- `GET /op/api/protected`：鉴权测试端点

## 本地开发与检查

在项目根目录创建 `.dev.vars`（勿提交）：

```dotenv
# 可选：不设置则请求需在 Authorization 头中自带 NIM key
NIM_API_KEY=your-nvidia-nim-key
```

运行 `npm run dev`、`npm run typecheck` 和 `npm test`。

## GitHub Actions 自动部署

在 GitHub 仓库设置以下 Actions secrets 后，推送到 `main` 会部署 Worker：

- `CLOUDFLARE_API_TOKEN`：拥有此 Worker 部署权限的 Cloudflare API Token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID。

`NIM_API_KEY`（如使用）仍应使用 `wrangler secret put` 配置在 Cloudflare Worker，而不是放进 GitHub Actions。
