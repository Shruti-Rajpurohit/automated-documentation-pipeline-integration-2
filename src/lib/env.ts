// Server runtime defaults: host-provided env always wins (dotenv never
// overrides), so compose/production secrets come from real environment
// variables and .env.local only backfills local/development defaults.
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });
