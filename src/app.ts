import express from "express";
import { conversionRouter } from "./routes/conversion.routes.js";
import { AppError } from "./errors.js";
import { config } from "./config.js";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use("/files", express.static(config.uploadRoot));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/conversions", conversionRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ message: err.message });
      return;
    }

    if (err instanceof Error) {
      res.status(500).json({ message: err.message });
      return;
    }

    res.status(500).json({ message: "알 수 없는 서버 오류가 발생했습니다." });
  });

  return app;
}
