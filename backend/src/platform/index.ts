import { env } from "../config/index.js";
import type { PlatformAdapter } from "./PlatformAdapter.js";
import { HttpPlatformAdapter } from "./impl/http/adapter.js";
import { MockPlatformAdapter } from "./impl/mock/adapter.js";
import { logger } from "../observability/logger.js";

let instance: PlatformAdapter | null = null;

export function getPlatformAdapter(): PlatformAdapter {
  if (!instance) {
    if (env.PLATFORM_MODE === "mock") {
      logger.warn("PLATFORM_MODE=mock — outbound sends will not reach the real platform");
      instance = new MockPlatformAdapter();
    } else {
      instance = new HttpPlatformAdapter();
    }
  }
  return instance;
}

export function setPlatformAdapter(adapter: PlatformAdapter): void {
  instance = adapter;
}
