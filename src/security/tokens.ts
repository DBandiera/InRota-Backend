import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { AppError } from "../errors.js";

type TokenKind = "registration" | "access";

export interface TokenClaims {
  subject: string;
  deviceId: string;
}

export class TokenService {
  private readonly secret: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer = "inrota-api"
  ) {
    this.secret = new TextEncoder().encode(secret);
  }

  async sign(
    kind: TokenKind,
    claims: TokenClaims,
    expiresInSeconds: number
  ): Promise<string> {
    return new SignJWT({ kind, deviceId: claims.deviceId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience("inrota-android")
      .setSubject(claims.subject)
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.secret);
  }

  async verify(token: string, expectedKind: TokenKind): Promise<TokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: "inrota-android"
      });
      if (
        payload.kind !== expectedKind ||
        typeof payload.sub !== "string" ||
        typeof payload.deviceId !== "string"
      ) {
        throw new Error("Claims inválidas");
      }
      return { subject: payload.sub, deviceId: payload.deviceId };
    } catch {
      throw new AppError(401, "INVALID_TOKEN", "Token inválido ou expirado.");
    }
  }
}

export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
