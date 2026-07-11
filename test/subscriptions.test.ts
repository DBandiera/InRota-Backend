import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../src/database/client.js";
import { AppError } from "../src/errors.js";
import { SubscriptionService } from "../src/subscriptions/subscription-service.js";

test("teste gratuito válido concede acesso até a expiração", async () => {
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);
  const database = {
    query: async () => ({
      rows: [
        {
          status: "TRIAL",
          product_id: "inrota_pro",
          expires_at: expiresAt,
          will_renew: true
        }
      ],
      rowCount: 1
    })
  } as unknown as Database;
  const service = new SubscriptionService(database, "s".repeat(32), "pro");

  const status = await service.getStatus("user-id");

  assert.equal(status.hasAccess, true);
  assert.equal(status.status, "TRIAL");
  assert.equal(status.productId, "inrota_pro");
  assert.equal(status.willRenew, true);
});

test("assinatura vencida não concede acesso", async () => {
  const database = {
    query: async () => ({
      rows: [
        {
          status: "CANCELED",
          product_id: "inrota_pro",
          expires_at: new Date(Date.now() - 1_000),
          will_renew: false
        }
      ],
      rowCount: 1
    })
  } as unknown as Database;
  const service = new SubscriptionService(database, "s".repeat(32), "pro");

  const status = await service.getStatus("user-id");

  assert.equal(status.hasAccess, false);
  assert.equal(status.status, "EXPIRED");
  assert.equal(status.willRenew, false);
});

test("webhook rejeita autorização incorreta antes de acessar o banco", async () => {
  let databaseAccessed = false;
  const database = {
    query: async () => {
      databaseAccessed = true;
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Database;
  const service = new SubscriptionService(database, "s".repeat(32), "pro");

  await assert.rejects(
    () =>
      service.processRevenueCatWebhook("Bearer incorreto", {
        event: {
          id: "event-id",
          type: "INITIAL_PURCHASE",
          app_user_id: "6f64cf2b-c19b-45f0-b360-9f370cf4f8b5"
        }
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_WEBHOOK_AUTH"
  );
  assert.equal(databaseAccessed, false);
});
