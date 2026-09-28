import { healthCheck } from "../src/app";
import { vercelHandler } from "../src/vercel";

export const GET = vercelHandler(healthCheck);
