// Imported before ../rounds.mjs: the tests read this fixture config, never the user's local/rounds.json.
import { fileURLToPath } from 'node:url';

process.env.FOWLBROWSER_ROUNDS_CONFIG = fileURLToPath(new URL('./rounds-config.json', import.meta.url));
