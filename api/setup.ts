import { setupBootErrorPage, setupPage } from "../src/app";
import { vercelHandler } from "../src/vercel";

export const GET = vercelHandler(setupPage, (message) => setupBootErrorPage(process.env, message));
