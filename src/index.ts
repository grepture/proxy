import { resolve } from "path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config";
import { proxyHandler } from "./proxy/handler";
import { anthropicMiddleware } from "./proxy/anthropic-middleware";
import { cursorMiddleware } from "./proxy/cursor-middleware";
import { scanHandler, accountHandler } from "./scan/handler";
import { scanFilesHandler } from "./scan/files-handler";
import { traceHandler } from "./proxy/trace-handler";
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

app.post("/v1/scan", scanHandler);
app.post("/v1/scan-files", scanFilesHandler);
app.get("/v1/account", accountHandler);
app.post("/v1/trace", traceHandler);

app.get("/v1/prompts", async (c) => {
  const authHeader = c.req.header("authorization") || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!apiKey) return c.json({ error: "Missing Authorization header" }, 401);

  const providers = getProviders();
  const auth = await providers.auth.authenticate(apiKey);
  if (!auth) return c.json({ error: "Invalid API key" }, 401);

  const { supabase } = require("./infra/supabase");
  const { data, error } = await supabase
    .from("prompts")
    .select("id, slug, name, active_version, updated_at")
    .eq("team_id", auth.team_id)
    .order("updated_at", { ascending: false });

  if (error) return c.json({ error: "Failed to list prompts" }, 500);
  return c.json(data ?? []);
});

app.get("/v1/prompts/:slugRef", async (c) => {
  const authHeader = c.req.header("authorization") || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!apiKey) return c.json({ error: "Missing Authorization header" }, 401);

  const providers = getProviders();
  const auth = await providers.auth.authenticate(apiKey);
  if (!auth) return c.json({ error: "Invalid API key" }, 401);

  const slugRef = c.req.param("slugRef");
  const atIdx = slugRef.indexOf("@");
  const slug = atIdx >= 0 ? slugRef.slice(0, atIdx) : slugRef;
  const ref = atIdx >= 0 ? slugRef.slice(atIdx + 1) : undefined;

  const { fetchPrompt } = require("./prompts/cache");
  const result = await fetchPrompt(auth.team_id, slug, ref);
  if (!result) return c.json({ error: "Prompt not found" }, 404);

  return c.json({
    slug: result.prompt.slug,
    name: result.prompt.name,
    skip_rules: result.prompt.skip_rules,
    version: result.version.version,
    messages: result.version.messages,
    variables: result.version.variables,
  });
});

app.use("/claude/v1/messages", anthropicMiddleware);
app.use("/claude/v1/messages/*", anthropicMiddleware);
app.use("/cursor/:greptureKey/*", cursorMiddleware);
app.all("/*", proxyHandler);

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
