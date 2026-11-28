// Rewrites every sample lab in src/labs from its builder in src/labs/build.ts.
import { writeFileSync } from 'node:fs';
import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
try {
  const { BUILDERS } = await server.ssrLoadModule('/src/labs/build.ts');
  const { serializeTopology } = await server.ssrLoadModule('/src/model/index.ts');
  for (const [id, build] of Object.entries(BUILDERS)) {
    writeFileSync(
      new URL(`../src/labs/${id}.tracer.json`, import.meta.url),
      `${serializeTopology(build())}\n`,
    );
    console.log(`wrote src/labs/${id}.tracer.json`);
  }
} finally {
  await server.close();
}
