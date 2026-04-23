import pino from "pino";
import { env } from "../config/index.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { env: env.NODE_ENV, account: env.ACCOUNT_ID },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
