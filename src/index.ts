import { createApp } from "./app.js";
import { config } from "./config.js";
import { ensureDir } from "./utils/fs.js";

async function bootstrap() {
  await Promise.all([
    ensureDir(config.uploadRoot),
    ensureDir(config.publicDir)
  ]);

  const app = createApp();

  app.listen(config.port, () => {
    console.log(`IFC to FRAG 서버가 ${config.port} 포트에서 실행 중입니다.`);
  });
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "알 수 없는 시작 오류가 발생했습니다.";
  console.error(message);
  process.exit(1);
});
