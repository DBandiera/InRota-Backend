import { GoogleAuth } from "google-auth-library";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";

interface IntegrityResponse {
  tokenPayloadExternal?: {
    requestDetails?: {
      requestPackageName?: string;
      requestHash?: string;
    };
    appIntegrity?: {
      appRecognitionVerdict?: string;
      packageName?: string;
      certificateSha256Digest?: string[];
    };
    deviceIntegrity?: {
      deviceRecognitionVerdict?: string[];
    };
    accountDetails?: {
      appLicensingVerdict?: string;
    };
  };
}

export interface IntegrityVerdict {
  appRecognition: string;
  deviceVerdicts: string[];
}

export class PlayIntegrityService {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/playintegrity"]
  });

  constructor(private readonly config: Config) {}

  async verify(token: string | undefined, expectedRequestHash: string): Promise<IntegrityVerdict> {
    if (!this.config.PLAY_INTEGRITY_ENABLED) {
      if (this.config.NODE_ENV === "production") {
        throw new AppError(
          503,
          "INTEGRITY_NOT_CONFIGURED",
          "A validação Play Integrity precisa estar ativa em produção."
        );
      }
      return { appRecognition: "DEVELOPMENT_BYPASS", deviceVerdicts: [] };
    }
    if (!token) {
      throw new AppError(401, "INTEGRITY_REQUIRED", "Token Play Integrity ausente.");
    }

    let response: IntegrityResponse;
    try {
      const client = await this.auth.getClient();
      const url =
        `https://playintegrity.googleapis.com/v1/` +
        `${encodeURIComponent(this.config.ANDROID_PACKAGE_NAME)}:decodeIntegrityToken`;
      const result = await client.request<IntegrityResponse>({
        url,
        method: "POST",
        data: { integrity_token: token }
      });
      response = result.data;
    } catch (error) {
      const details = error as { code?: string | number; message?: string; response?: { status?: number } };
      console.error("Play Integrity decode failed", { code: details.code, status: details.response?.status, message: details.message });
      throw new AppError(
        401,
        "INVALID_INTEGRITY_TOKEN",
        "Não foi possível validar a integridade do aplicativo."
      );
    }

    const payload = response.tokenPayloadExternal;
    const app = payload?.appIntegrity;
    const deviceVerdicts = payload?.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const expectedCertificate = this.config.ANDROID_CERT_SHA256;
    const certificateMatches =
      !expectedCertificate ||
      (app?.certificateSha256Digest ?? []).includes(expectedCertificate);

    if (
      payload?.requestDetails?.requestPackageName !== this.config.ANDROID_PACKAGE_NAME ||
      payload.requestDetails.requestHash !== expectedRequestHash ||
      app?.appRecognitionVerdict !== "PLAY_RECOGNIZED" ||
      app.packageName !== this.config.ANDROID_PACKAGE_NAME ||
      !certificateMatches ||
      !deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY") ||
      (this.config.PLAY_REQUIRE_LICENSED &&
        payload.accountDetails?.appLicensingVerdict !== "LICENSED")
    ) {
      throw new AppError(
        403,
        "INTEGRITY_REJECTED",
        "O aplicativo ou aparelho não passou na verificação de integridade."
      );
    }

    return {
      appRecognition: app.appRecognitionVerdict,
      deviceVerdicts
    };
  }
}




