import type { Config } from "../config.js";
import type { Database } from "../database/client.js";
import { AppError } from "../errors.js";
import { normalizeMobilePhone } from "../phone/phone.js";
import {
  randomBase64Url,
  sha256,
  validateP256PublicKey,
  verifyDeviceSignature
} from "../security/crypto.js";
import {
  createRefreshToken,
  hashRefreshToken,
  TokenService
} from "../security/tokens.js";
import { GoogleIdentityService } from "./google.js";
import { PlayIntegrityService } from "./play-integrity.js";

interface ChallengeRow {
  id: string;
  installation_id: string;
  nonce: string;
  used_at: Date | null;
  expires_at: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  status: "PENDING_PHONE" | "ACTIVE" | "BLOCKED";
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  public_key_pem: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: Config,
    private readonly google: GoogleIdentityService,
    private readonly integrity: PlayIntegrityService,
    private readonly tokens: TokenService
  ) {}

  async createChallenge(installationId: string) {
    const nonce = randomBase64Url();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO auth_challenges (installation_id, nonce, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [installationId, nonce, expiresAt]
    );
    return {
      challengeId: result.rows[0]!.id,
      nonce,
      expiresAt: expiresAt.toISOString()
    };
  }

  async authenticateWithGoogle(input: {
    challengeId: string;
    googleIdToken: string;
    devicePublicKey: string;
    deviceSignature: string;
    integrityToken?: string | undefined;
  }) {
    validateP256PublicKey(input.devicePublicKey);

    const challengeResult = await this.database.query<ChallengeRow>(
      `SELECT id, installation_id, nonce, used_at, expires_at
       FROM auth_challenges WHERE id = $1`,
      [input.challengeId]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.used_at || challenge.expires_at.getTime() <= Date.now()) {
      throw new AppError(
        401,
        "INVALID_CHALLENGE",
        "O desafio de autenticação é inválido, expirou ou já foi utilizado."
      );
    }

    const signedPayload = `${challenge.id}.${challenge.nonce}`;
    verifyDeviceSignature(
      input.devicePublicKey,
      signedPayload,
      input.deviceSignature
    );

    const identity = await this.google.verify(
      input.googleIdToken,
      challenge.nonce
    );
    const expectedRequestHash = sha256(
      `auth:${challenge.id}:${challenge.nonce}`
    );
    const verdict = await this.integrity.verify(
      input.integrityToken,
      expectedRequestHash
    );

    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(
        `UPDATE auth_challenges SET used_at = now()
         WHERE id = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING id`,
        [challenge.id]
      );
      if (consumed.rowCount !== 1) {
        throw new AppError(409, "CHALLENGE_USED", "Este desafio já foi utilizado.");
      }

      const userResult = await client.query<UserRow>(
        `INSERT INTO users (google_sub, email, name, picture_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_sub) DO UPDATE SET
           email = EXCLUDED.email,
           name = EXCLUDED.name,
           picture_url = EXCLUDED.picture_url,
           updated_at = now()
         RETURNING id, email, name, status`,
        [
          identity.subject,
          identity.email,
          identity.name ?? null,
          identity.pictureUrl ?? null
        ]
      );
      const user = userResult.rows[0]!;
      if (user.status === "BLOCKED") {
        throw new AppError(403, "ACCOUNT_BLOCKED", "Esta conta está bloqueada.");
      }

      const deviceResult = await client.query<{ id: string }>(
        `INSERT INTO devices (
           user_id, installation_id, public_key_pem, package_name,
           app_recognition_verdict, device_integrity_verdicts
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, installation_id) DO UPDATE SET
           public_key_pem = EXCLUDED.public_key_pem,
           app_recognition_verdict = EXCLUDED.app_recognition_verdict,
           device_integrity_verdicts = EXCLUDED.device_integrity_verdicts,
           last_seen_at = now(),
           revoked_at = NULL
         RETURNING id`,
        [
          user.id,
          challenge.installation_id,
          input.devicePublicKey,
          this.config.ANDROID_PACKAGE_NAME,
          verdict.appRecognition,
          verdict.deviceVerdicts
        ]
      );
      const deviceId = deviceResult.rows[0]!.id;
      await client.query("COMMIT");

      if (user.status === "PENDING_PHONE") {
        const registrationToken = await this.tokens.sign(
          "registration",
          { subject: user.id, deviceId },
          this.config.REGISTRATION_TOKEN_TTL_SECONDS
        );
        return {
          nextStep: "PROVIDE_PHONE" as const,
          registrationToken,
          user: { id: user.id, email: user.email, name: user.name }
        };
      }

      const session = await this.issueSession(user.id, deviceId);
      return {
        nextStep: "AUTHENTICATED" as const,
        ...session,
        user: { id: user.id, email: user.email, name: user.name }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new AppError(
          409,
          "IDENTITY_CONFLICT",
          "Este e-mail já está vinculado a outra identidade."
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async registerPhone(userId: string, deviceId: string, rawPhone: string) {
    const phoneE164 = normalizeMobilePhone(rawPhone);
    try {
      const updated = await this.database.query(
        `UPDATE users SET
           phone_e164 = $1,
           phone_provided_at = now(),
           phone_verified_at = NULL,
           status = 'ACTIVE',
           updated_at = now()
         WHERE id = $2 AND status = 'PENDING_PHONE'
         RETURNING id`,
        [phoneE164, userId]
      );
      if (updated.rowCount !== 1) {
        throw new AppError(
          409,
          "PHONE_STEP_NOT_AVAILABLE",
          "O cadastro do telefone não está disponível para esta conta."
        );
      }
      const session = await this.issueSession(userId, deviceId);
      return {
        ...session,
        phone: this.maskPhone(phoneE164),
        phoneVerified: false
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new AppError(
          409,
          "PHONE_ALREADY_USED",
          "Este telefone já está vinculado a outra conta."
        );
      }
      throw error;
    }
  }

  async refreshSession(input: {
    refreshToken: string;
    timestamp: number;
    deviceSignature: string;
  }) {
    if (Math.abs(Date.now() - input.timestamp) > 2 * 60_000) {
      throw new AppError(401, "STALE_SIGNATURE", "A assinatura do aparelho expirou.");
    }
    const currentHash = hashRefreshToken(input.refreshToken);
    const result = await this.database.query<SessionRow>(
      `SELECT s.id, s.user_id, s.device_id, s.expires_at, s.revoked_at,
              d.public_key_pem
       FROM sessions s
       JOIN devices d ON d.id = s.device_id
       JOIN users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = $1
         AND d.revoked_at IS NULL
         AND u.status = 'ACTIVE'`,
      [currentHash]
    );
    const session = result.rows[0];
    if (
      !session ||
      session.revoked_at ||
      session.expires_at.getTime() <= Date.now()
    ) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "Sessão inválida ou expirada.");
    }

    verifyDeviceSignature(
      session.public_key_pem,
      `refresh.${currentHash}.${input.timestamp}`,
      input.deviceSignature
    );

    const nextRefresh = createRefreshToken();
    const rotated = await this.database.query(
      `UPDATE sessions SET
         refresh_token_hash = $1, last_used_at = now()
       WHERE id = $2 AND refresh_token_hash = $3 AND revoked_at IS NULL`,
      [nextRefresh.hash, session.id, currentHash]
    );
    if (rotated.rowCount !== 1) {
      throw new AppError(409, "REFRESH_REPLAYED", "Esta sessão já foi renovada.");
    }
    const accessToken = await this.tokens.sign(
      "access",
      { subject: session.user_id, deviceId: session.device_id },
      this.config.ACCESS_TOKEN_TTL_SECONDS
    );
    return {
      accessToken,
      refreshToken: nextRefresh.token,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS
    };
  }

  async logout(userId: string, deviceId: string): Promise<void> {
    await this.database.query(
      `UPDATE sessions
       SET revoked_at = now()
       WHERE user_id = $1
         AND device_id = $2
         AND revoked_at IS NULL`,
      [userId, deviceId]
    );
  }

  private async issueSession(userId: string, deviceId: string) {
    const refresh = createRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000
    );
    await this.database.query(
      `INSERT INTO sessions
        (user_id, device_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, deviceId, refresh.hash, refreshExpiresAt]
    );
    const accessToken = await this.tokens.sign(
      "access",
      { subject: userId, deviceId },
      this.config.ACCESS_TOKEN_TTL_SECONDS
    );
    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS
    };
  }

  private maskPhone(phone: string): string {
    return `${phone.slice(0, 3)}*****${phone.slice(-4)}`;
  }
}
