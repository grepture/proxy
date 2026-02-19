import { Redis } from "@upstash/redis";
import { config } from "../config";

export const redis = new Redis({
  url: config.upstashRedisUrl,
  token: config.upstashRedisToken,
});
