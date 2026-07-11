import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../auth/auth-service.js";
import type { Database } from "../database/client.js";
import { AppError } from "../errors.js";
import type { TokenService } from "../security/tokens.js";
import type { SubscriptionService } from "../subscriptions/subscription-service.js";
import {
  createChallengeSchema,
  googleAuthSchema,
  registerPhoneSchema,
  refreshSchema,
  revenueCatWebhookSchema,
} from "./schemas.js";

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "TOKEN_REQUIRED", "Token de acesso ausente.");
  }
  return authorization.slice("Bearer ".length);
}

export async function registerRoutes(
  app: FastifyInstance,
  auth: AuthService,
  tokens: TokenService,
  database: Database,
  subscriptions: SubscriptionService
) {
  app.get("/health", async () => {
    await database.query("SELECT 1");
    return { status: "ok", database: "ok" };
  });

  app.post(
    "/v1/auth/challenges",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = createChallengeSchema.parse(request.body);
      return reply.code(201).send(await auth.createChallenge(body.installationId));
    }
  );

  app.post(
    "/v1/auth/google",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = googleAuthSchema.parse(request.body);
      return auth.authenticateWithGoogle(body);
    }
  );

  app.post(
    "/v1/registration/phone",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request) => {
      const claims = await tokens.verify(bearerToken(request), "registration");
      const body = registerPhoneSchema.parse(request.body);
      return auth.registerPhone(
        claims.subject,
        claims.deviceId,
        body.phone
      );
    }
  );

  app.post(
    "/v1/auth/refresh",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => auth.refreshSession(refreshSchema.parse(request.body))
  );

  app.post(
    "/v1/auth/logout",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const claims = await tokens.verify(bearerToken(request), "access");
      await auth.logout(claims.subject, claims.deviceId);
      return reply.code(204).send();
    }
  );

  app.get("/v1/subscriptions/status", async (request) => {
    const claims = await tokens.verify(bearerToken(request), "access");
    return subscriptions.getStatus(claims.subject);
  });

  app.post("/v1/subscriptions/sync", async (request) => {
    const claims = await tokens.verify(bearerToken(request), "access");
    return subscriptions.syncFromRevenueCat(claims.subject);
  });

  app.post(
    "/v1/webhooks/revenuecat",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) =>
      subscriptions.processRevenueCatWebhook(
        request.headers.authorization,
        revenueCatWebhookSchema.parse(request.body)
      )
  );
}
