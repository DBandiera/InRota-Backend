import { z } from "zod";

export const installationId = z.string().uuid();

export const createChallengeSchema = z.object({
  installationId
});

export const googleAuthSchema = z.object({
  challengeId: z.string().uuid(),
  googleIdToken: z.string().min(100),
  devicePublicKey: z.string().min(100).max(2_000),
  deviceSignature: z.string().min(32).max(256),
  integrityToken: z.string().min(100).optional()
});

export const registerPhoneSchema = z.object({
  phone: z.string().min(8).max(30)
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(40),
  timestamp: z.number().int().positive(),
  deviceSignature: z.string().min(32).max(256)
});

export const revenueCatWebhookSchema = z.object({
  api_version: z.string().optional(),
  event: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    app_user_id: z.string().min(1).optional(),
    aliases: z.array(z.string()).optional(),
    entitlement_ids: z.array(z.string()).optional(),
    product_id: z.string().optional(),
    period_type: z.string().optional(),
    store: z.string().optional(),
    transaction_id: z.string().optional(),
    original_transaction_id: z.string().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    event_timestamp_ms: z.number().optional(),
    grace_period_expiration_at_ms: z.number().nullable().optional(),
    transferred_from: z.array(z.string()).optional(),
    transferred_to: z.array(z.string()).optional()
  })
});
