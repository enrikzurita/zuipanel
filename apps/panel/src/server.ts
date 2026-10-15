import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';

const config = loadConfig();
if ((process.env.AUTO_MIGRATE ?? 'true') === 'true') await migrate(config.databaseUrl);
const { app } = await buildApp(config);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
