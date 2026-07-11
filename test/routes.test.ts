import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AuthService } from "../src/auth/auth-service.js";
import type { Database } from "../src/database/client.js";
import { registerRoutes } from "../src/http/routes.js";
import { TokenService } from "../src/security/tokens.js";
import type { SubscriptionService } from "../src/subscriptions/subscription-service.js";

const subscriptions = {
  getStatus: async () => ({
    hasAccess: false,
    status: "INACTIVE",
    productId: null,
    expiresAt: null,
    willRenew: false
  })
} as SubscriptionService;

test("logout revoga as sessões do usuário no aparelho autenticado", async () => {
  const app = Fastify();
  const tokens = new TokenService("a".repeat(32));
  const accessToken = await tokens.sign(
    "access",
    { subject: "user-id", deviceId: "device-id" },
    60
  );
  let revokedIdentity: { userId: string; deviceId: string } | undefined;

  const auth = {
    logout: async (userId: string, deviceId: string) => {
      revokedIdentity = { userId, deviceId };
    }
  } as AuthService;
  const database = {
    query: async () => ({ rows: [], rowCount: 1 })
  } as unknown as Database;

  await registerRoutes(app, auth, tokens, database, subscriptions);

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(revokedIdentity, {
    userId: "user-id",
    deviceId: "device-id"
  });

  await app.close();
});

test("health confirma a consulta ao banco", async () => {
  const app = Fastify();
  const tokens = new TokenService("a".repeat(32));
  let databaseChecked = false;
  const auth = {} as AuthService;
  const database = {
    query: async (query: string) => {
      databaseChecked = query === "SELECT 1";
      return { rows: [], rowCount: 1 };
    }
  } as unknown as Database;

  await registerRoutes(app, auth, tokens, database, subscriptions);

  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(databaseChecked, true);
  assert.deepEqual(response.json(), {
    status: "ok",
    database: "ok"
  });

  await app.close();
});

test("status da assinatura exige login e usa o usuário do token", async () => {
  const app = Fastify();
  const tokens = new TokenService("a".repeat(32));
  const accessToken = await tokens.sign(
    "access",
    { subject: "subscriber-id", deviceId: "device-id" },
    60
  );
  let requestedUserId: string | undefined;
  const subscriptionService = {
    getStatus: async (userId: string) => {
      requestedUserId = userId;
      return {
        hasAccess: true,
        status: "TRIAL",
        productId: "inrota_pro",
        expiresAt: "2026-07-07T00:00:00.000Z",
        willRenew: true
      };
    }
  } as SubscriptionService;
  const database = {
    query: async () => ({ rows: [], rowCount: 1 })
  } as unknown as Database;

  await registerRoutes(
    app,
    {} as AuthService,
    tokens,
    database,
    subscriptionService
  );

  const unauthorized = await app.inject({
    method: "GET",
    url: "/v1/subscriptions/status"
  });
  const authorized = await app.inject({
    method: "GET",
    url: "/v1/subscriptions/status",
    headers: { authorization: `Bearer ${accessToken}` }
  });

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(authorized.statusCode, 200);
  assert.equal(requestedUserId, "subscriber-id");
  assert.equal(authorized.json().status, "TRIAL");

  await app.close();
});
