import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
