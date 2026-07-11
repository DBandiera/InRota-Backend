import {
  createHash,
  createPublicKey,
  randomBytes,
  verify
} from "node:crypto";
import { AppError } from "../errors.js";

export function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function validateP256PublicKey(publicKeyPem: string): void {
  try {
    const key = createPublicKey(publicKeyPem);
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") {
      throw new Error("Curva inválida");
    }
  } catch {
    throw new AppError(
      400,
      "INVALID_DEVICE_KEY",
      "A chave do aparelho deve ser uma chave pública ECDSA P-256 válida."
    );
  }
}

export function verifyDeviceSignature(
  publicKeyPem: string,
  payload: string,
  signatureBase64Url: string
): void {
  const isValid = verify(
    "sha256",
    Buffer.from(payload, "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureBase64Url, "base64url")
  );
  if (!isValid) {
    throw new AppError(
      401,
      "INVALID_DEVICE_SIGNATURE",
      "A assinatura criptográfica do aparelho é inválida."
    );
  }
}
