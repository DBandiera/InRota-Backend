import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { AuthService } from "./auth/auth-service.js";
import { GoogleIdentityService } from "./auth/google.js";
import { PlayIntegrityService } from "./auth/play-integrity.js";
import type { Config } from "./config.js";
import { createDatabase } from "./database/client.js";
import { AppError } from "./errors.js";
import { registerRoutes } from "./http/routes.js";
import { TokenService } from "./security/tokens.js";
import { SubscriptionService } from "./subscriptions/subscription-service.js";

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "body.googleIdToken",
        "body.integrityToken",
        "body.code",
        "body.refreshToken"
      ]
    },
    trustProxy:
      config.TRUST_PROXY_HOPS > 0 ? config.TRUST_PROXY_HOPS : false,
    bodyLimit: 64 * 1024
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: false
  });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute"
  });

  const database = createDatabase(config.DATABASE_URL);
  const tokens = new TokenService(config.JWT_SECRET);
  const auth = new AuthService(
    database,
    config,
    new GoogleIdentityService(
      config.GOOGLE_WEB_CLIENT_ID,
      config.REQUIRE_GMAIL_DOMAIN
    ),
    new PlayIntegrityService(config),
    tokens
  );
  const subscriptions = new SubscriptionService(
    database,
    config.REVENUECAT_WEBHOOK_AUTH_TOKEN,
    config.REVENUECAT_ENTITLEMENT_ID,
    config.REVENUECAT_SECRET_API_KEY
  );

  app.addHook("onClose", async () => {
    await database.end();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Os dados enviados são inválidos.",
          details: error.flatten()
        }
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message }
      });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Ocorreu um erro interno."
      }
    });
  });

  await registerRoutes(app, auth, tokens, database, subscriptions);
  return app;
}
