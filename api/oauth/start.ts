import { oauthStart } from "../../src/app";
import { vercelHandler } from "../../src/vercel";

export const GET = vercelHandler(oauthStart);
