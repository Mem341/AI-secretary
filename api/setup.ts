import { setupBootErrorPage, setupPage } from "../src/app";
import { databaseUrl, vercelHandler } from "../src/vercel";

export const GET = vercelHandler(setupPage, (message) => setupBootErrorPage(process.env, databaseUrl(), message));
