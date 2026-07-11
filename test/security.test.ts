import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { normalizeMobilePhone } from "../src/phone/phone.js";
import {
  sha256,
  validateP256PublicKey,
  verifyDeviceSignature
} from "../src/security/crypto.js";
import {
  createRefreshToken,
  hashRefreshToken,
  TokenService
} from "../src/security/tokens.js";

test("valida uma assinatura produzida pela chave do aparelho", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = "challenge-id.nonce";
  const signature = sign("sha256", Buffer.from(payload), privateKey).toString(
    "base64url"
  );

  validateP256PublicKey(publicKeyPem);
  assert.doesNotThrow(() =>
    verifyDeviceSignature(publicKeyPem, payload, signature)
  );
  assert.throws(() =>
    verifyDeviceSignature(publicKeyPem, `${payload}-alterado`, signature)
  );
});

test("rejeita uma chave que não seja P-256", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => validateP256PublicKey(pem));
});

test("aceita celular brasileiro e rejeita telefone fixo", () => {
  assert.equal(normalizeMobilePhone("(11) 99999-9999"), "+5511999999999");
  assert.throws(() => normalizeMobilePhone("(11) 3333-4444"));
});

test("token de cadastro não pode ser usado como token de acesso", async () => {
  const tokens = new TokenService("a".repeat(32));
  const token = await tokens.sign(
    "registration",
    { subject: "user-id", deviceId: "device-id" },
    60
  );
  const claims = await tokens.verify(token, "registration");
  assert.equal(claims.subject, "user-id");
  await assert.rejects(() => tokens.verify(token, "access"));
});

test("refresh token é aleatório e armazenado somente como hash", () => {
  const first = createRefreshToken();
  const second = createRefreshToken();
  assert.notEqual(first.token, second.token);
  assert.equal(first.hash, hashRefreshToken(first.token));
  assert.notEqual(first.hash, sha256(first.token));
});
