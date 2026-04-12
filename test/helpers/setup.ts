/**
 * Test preload: set dummy env vars for modules that eagerly initialize
 * clients at import time (Supabase, Redis). Tests use injected providers
 * and never hit these services, but the modules still load transitively
 * from handler.ts imports.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "dummy-key-for-tests";
