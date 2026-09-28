import { gcalPush } from "../src/app";
import { vercelHandler } from "../src/vercel";

export const POST = vercelHandler(gcalPush);
