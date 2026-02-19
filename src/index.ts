import { resolve } from "path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { proxyHandler } from "./proxy/handler";
import { getProviders } from "./providers";
import { registerBuiltinActions } from "./actions/builtin";

// Register core actions
registerBuiltinActions();

// Load plugins (resolve relative paths from CWD)
for (const pluginPath of config.plugins) {
  const resolved = pluginPath.startsWith(".") ? resolve(process.cwd(), pluginPath) : pluginPath;
  try {
    require(resolved);
  } catch (err) {
    console.error(`Failed to load plugin "${pluginPath}":`, err);
    process.exit(1);
  }
}

const app = new Hono();

// --- Middleware ---

// Assign X-Request-Id
app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") || crypto.randomUUID();
  c.set("requestId" as never, requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// CORS
app.use("*", cors());

// --- Routes ---

app.get("/health", (c) => c.json({ status: "ok" }));

app.all("/proxy/*", proxyHandler);

// --- Start ---

console.log(`Grepture proxy listening on :${config.port} (mode: ${config.mode})`);

// Eagerly warm up AI models if any plugin exported warmupModels
for (const pluginPath of config.plugins) {
  const resolved = pluginPath.startsWith(".") ? resolve(process.cwd(), pluginPath) : pluginPath;
  try {
    const plugin = require(resolved);
    if (typeof plugin.warmupModels === "function") {
      plugin.warmupModels().catch((err: unknown) => {
        console.error("AI model warmup failed (AI actions will lazy-load on first use):", err);
      });
    }
  } catch {
    // Already reported above
  }
}

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

// Graceful shutdown
function shutdown() {
  console.log("Shutting down, flushing logs...");
  getProviders().log.flush().then(() => {
    server.stop();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
