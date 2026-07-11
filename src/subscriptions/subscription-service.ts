import { timingSafeEqual } from "node:crypto";
import type { Database } from "../database/client.js";
import { AppError } from "../errors.js";

type SubscriptionStatus =
  | "INACTIVE"
  | "TRIAL"
  | "ACTIVE"
  | "GRACE_PERIOD"
  | "BILLING_ISSUE"
  | "CANCELED"
  | "PAUSED"
  | "EXPIRED";

interface SubscriptionRow {
  status: SubscriptionStatus;
  product_id: string | null;
  expires_at: Date | null;
  will_renew: boolean;
}

export interface RevenueCatWebhook {
  api_version?: string | undefined;
  event: {
    id: string;
    type: string;
    app_user_id?: string | undefined;
    aliases?: string[] | undefined;
    entitlement_ids?: string[] | undefined;
    product_id?: string | undefined;
    period_type?: string | undefined;
    store?: string | undefined;
    transaction_id?: string | undefined;
    original_transaction_id?: string | undefined;
    expiration_at_ms?: number | null | undefined;
    event_timestamp_ms?: number | undefined;
    grace_period_expiration_at_ms?: number | null | undefined;
    transferred_from?: string[] | undefined;
    transferred_to?: string[] | undefined;
  };
}

export class SubscriptionService {
  constructor(
    private readonly database: Database,
    private readonly webhookToken: string,
    private readonly entitlementId: string,
    private readonly secretApiKey = ""
  ) {}

  async getStatus(userId: string) {
    const result = await this.database.query<SubscriptionRow>(
      `SELECT status, product_id, expires_at, will_renew
       FROM subscriptions
       WHERE user_id = $1`,
      [userId]
    );
    const subscription = result.rows[0];

    if (!subscription) {
      return this.emptyStatus();
    }

    const expiresAt = subscription.expires_at;
    const hasTimeRemaining =
      expiresAt !== null && expiresAt.getTime() > Date.now();
    const accessStatuses: SubscriptionStatus[] = [
      "TRIAL",
      "ACTIVE",
      "GRACE_PERIOD",
      "BILLING_ISSUE",
      "CANCELED"
    ];
    const hasAccess =
      hasTimeRemaining && accessStatuses.includes(subscription.status);

    return {
      hasAccess,
      status: hasAccess ? subscription.status : "EXPIRED",
      productId: subscription.product_id,
      expiresAt: expiresAt?.toISOString() ?? null,
      willRenew: hasAccess && subscription.will_renew
    };
  }

  async processRevenueCatWebhook(
    authorization: string | undefined,
    payload: RevenueCatWebhook
  ): Promise<{ processed: boolean }> {
    this.verifyWebhookAuthorization(authorization);

    const event = payload.event;
    const eventTime = new Date(event.event_timestamp_ms ?? Date.now());
    const userId = await this.findUserId([
      ...(event.app_user_id ? [event.app_user_id] : []),
      ...(event.aliases ?? [])
    ]);

    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO billing_events (
           id, provider, event_type, user_id, event_time, payload
         )
         VALUES ($1, 'REVENUECAT', $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [event.id, event.type, userId, eventTime, payload]
      );

      if (inserted.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { processed: false };
      }

      const status = this.mapEventStatus(event);
      const appliesToEntitlement =
        !event.entitlement_ids ||
        event.entitlement_ids.length === 0 ||
        event.entitlement_ids.includes(this.entitlementId);

      if (userId && status && appliesToEntitlement) {
        const expiresAtMs =
          event.grace_period_expiration_at_ms ??
          event.expiration_at_ms ??
          null;
        const expiresAt =
          expiresAtMs === null ? null : new Date(expiresAtMs);

        await client.query(
          `INSERT INTO subscriptions (
             user_id, entitlement_id, product_id, status, store,
             transaction_id, original_transaction_id, expires_at,
             will_renew, event_time
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id) DO UPDATE SET
             entitlement_id = EXCLUDED.entitlement_id,
             product_id = EXCLUDED.product_id,
             status = EXCLUDED.status,
             store = EXCLUDED.store,
             transaction_id = EXCLUDED.transaction_id,
             original_transaction_id = EXCLUDED.original_transaction_id,
             expires_at = EXCLUDED.expires_at,
             will_renew = EXCLUDED.will_renew,
             event_time = EXCLUDED.event_time,
             updated_at = now()
           WHERE subscriptions.event_time <= EXCLUDED.event_time`,
          [
            userId,
            this.entitlementId,
            event.product_id ?? null,
            status,
            event.store ?? null,
            event.transaction_id ?? null,
            event.original_transaction_id ?? null,
            expiresAt,
            this.willRenew(event.type),
            eventTime
          ]
        );
      }

      await client.query("COMMIT");
      return { processed: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async syncFromRevenueCat(userId: string) {
    if (!this.secretApiKey) {
      throw new AppError(
        503,
        "BILLING_NOT_CONFIGURED",
        "A consulta de assinaturas ainda não foi configurada."
      );
    }

    const response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.secretApiKey}`
        },
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!response.ok) {
      throw new AppError(
        502,
        "BILLING_PROVIDER_ERROR",
        "Não foi possível confirmar a assinatura."
      );
    }

    const payload = (await response.json()) as RevenueCatCustomerResponse;
    const subscriber = payload.subscriber;
    const entitlement = subscriber?.entitlements?.[this.entitlementId];
    if (!subscriber || !entitlement) {
      return this.getStatus(userId);
    }

    const productId = entitlement.product_identifier;
    const subscription = productId
      ? subscriber.subscriptions?.[productId]
      : undefined;
    const expiresAtValue =
      entitlement.grace_period_expires_date ?? entitlement.expires_date;
    const expiresAt = expiresAtValue ? new Date(expiresAtValue) : null;
    const hasTimeRemaining =
      expiresAt !== null && expiresAt.getTime() > Date.now();
    const status: SubscriptionStatus = !hasTimeRemaining
      ? "EXPIRED"
      : subscription?.period_type?.toLowerCase() === "trial"
        ? "TRIAL"
        : subscription?.billing_issues_detected_at
          ? "BILLING_ISSUE"
          : subscription?.unsubscribe_detected_at
            ? "CANCELED"
            : "ACTIVE";
    const eventTime = new Date();

    await this.database.query(
      `INSERT INTO subscriptions (
         user_id, entitlement_id, product_id, status, store,
         transaction_id, original_transaction_id, expires_at,
         will_renew, event_time
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)
       ON CONFLICT (user_id) DO UPDATE SET
         entitlement_id = EXCLUDED.entitlement_id,
         product_id = EXCLUDED.product_id,
         status = EXCLUDED.status,
         store = EXCLUDED.store,
         transaction_id = EXCLUDED.transaction_id,
         original_transaction_id = EXCLUDED.original_transaction_id,
         expires_at = EXCLUDED.expires_at,
         will_renew = EXCLUDED.will_renew,
         event_time = EXCLUDED.event_time,
         updated_at = now()`,
      [
        userId,
        this.entitlementId,
        productId ?? null,
        status,
        subscription?.store ?? null,
        subscription?.store_transaction_id?.toString() ?? null,
        expiresAt,
        hasTimeRemaining &&
          !subscription?.unsubscribe_detected_at &&
          !subscription?.billing_issues_detected_at,
        eventTime
      ]
    );

    return this.getStatus(userId);
  }

  private emptyStatus() {
    return {
      hasAccess: false,
      status: "INACTIVE" as const,
      productId: null,
      expiresAt: null,
      willRenew: false
    };
  }

  private verifyWebhookAuthorization(authorization: string | undefined) {
    if (!this.webhookToken) {
      throw new AppError(
        503,
        "BILLING_NOT_CONFIGURED",
        "O recebimento de assinaturas ainda não foi configurado."
      );
    }

    const expected = Buffer.from(`Bearer ${this.webhookToken}`);
    const received = Buffer.from(authorization ?? "");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new AppError(
        401,
        "INVALID_WEBHOOK_AUTH",
        "A autenticação do webhook é inválida."
      );
    }
  }

  private async findUserId(candidates: string[]): Promise<string | null> {
    const validIds = candidates.filter((candidate) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate
      )
    );
    if (validIds.length === 0) {
      return null;
    }

    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM users WHERE id = ANY($1::uuid[]) LIMIT 1`,
      [validIds]
    );
    return result.rows[0]?.id ?? null;
  }

  private mapEventStatus(
    event: RevenueCatWebhook["event"]
  ): SubscriptionStatus | null {
    if (
      [
        "INITIAL_PURCHASE",
        "RENEWAL",
        "PRODUCT_CHANGE",
        "UNCANCELLATION",
        "SUBSCRIPTION_EXTENDED",
        "REFUND_REVERSED"
      ].includes(event.type)
    ) {
      return event.period_type === "TRIAL" ? "TRIAL" : "ACTIVE";
    }

    const statuses: Record<string, SubscriptionStatus> = {
      BILLING_ISSUE: "BILLING_ISSUE",
      CANCELLATION: "CANCELED",
      EXPIRATION: "EXPIRED",
      SUBSCRIPTION_PAUSED: "PAUSED"
    };
    return statuses[event.type] ?? null;
  }

  private willRenew(eventType: string): boolean {
    return ![
      "CANCELLATION",
      "EXPIRATION",
      "SUBSCRIPTION_PAUSED",
      "BILLING_ISSUE"
    ].includes(eventType);
  }
}

interface RevenueCatCustomerResponse {
  subscriber?: {
    entitlements?: Record<
      string,
      {
        expires_date?: string | null;
        grace_period_expires_date?: string | null;
        product_identifier?: string;
      }
    >;
    subscriptions?: Record<
      string,
      {
        billing_issues_detected_at?: string | null;
        expires_date?: string | null;
        period_type?: string;
        store?: string;
        store_transaction_id?: string | number;
        unsubscribe_detected_at?: string | null;
      }
    >;
  };
}
