import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { AppError } from "../errors.js";

export interface GoogleIdentity {
  subject: string;
  email: string;
  name?: string;
  pictureUrl?: string;
}

export class GoogleIdentityService {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly audience: string,
    private readonly requireGmailDomain: boolean
  ) {}

  async verify(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audience
      });
      payload = ticket.getPayload();
    } catch {
      throw new AppError(
        401,
        "INVALID_GOOGLE_TOKEN",
        "Não foi possível validar a conta Google."
      );
    }

    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.nonce !== expectedNonce
    ) {
      throw new AppError(
        401,
        "INVALID_GOOGLE_IDENTITY",
        "A identidade Google, o e-mail ou o nonce não são válidos."
      );
    }

    const email = payload.email.toLowerCase();
    if (this.requireGmailDomain && !email.endsWith("@gmail.com")) {
      throw new AppError(
        403,
        "GMAIL_REQUIRED",
        "O cadastro aceita somente endereços @gmail.com."
      );
    }

    return {
      subject: payload.sub,
      email,
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.picture ? { pictureUrl: payload.picture } : {})
    };
  }
}
