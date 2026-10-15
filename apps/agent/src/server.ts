import { buildAgent } from './app.js';
import { loadAgentConfig } from './config.js';

const agent = await buildAgent(loadAgentConfig());
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await agent.stop();
    process.exit(0);
  });
}
await agent.start();
