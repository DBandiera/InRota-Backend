import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  GOOGLE_WEB_CLIENT_ID: z.string().min(1),
  REQUIRE_GMAIL_DOMAIN: booleanFromString.default("true"),
  ANDROID_PACKAGE_NAME: z.string().min(1),
  ANDROID_CERT_SHA256: z.string().default(""),
  PLAY_INTEGRITY_ENABLED: booleanFromString,
  PLAY_REQUIRE_LICENSED: booleanFromString,
  REVENUECAT_WEBHOOK_AUTH_TOKEN: z.string().default(""),
  REVENUECAT_SECRET_API_KEY: z.string().default(""),
  REVENUECAT_ENTITLEMENT_ID: z.string().default("pro"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REGISTRATION_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuração inválida: ${fields}`);
  }
  return result.data;
}
