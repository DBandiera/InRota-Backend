# Integração com o aplicativo Android

## 1. Identificador e chave da instalação

Na primeira execução, gere um UUID e guarde-o em armazenamento privado como
`installationId`. Crie no Android Keystore uma chave:

- algoritmo: EC;
- curva: `secp256r1` / P-256;
- finalidade: assinatura;
- digest: SHA-256;
- alias sugerido: `inrota_device_key_v1`.

Envie a chave pública no formato PEM/SPKI:

```text
-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
```

Não exporte nem envie a chave privada.

## 2. Criar o desafio

`POST /v1/auth/challenges`

```json
{
  "installationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Resposta:

```json
{
  "challengeId": "3a5c7d96-ccef-49f5-8583-ed87d11fd329",
  "nonce": "valor-aleatorio-base64url",
  "expiresAt": "2026-06-28T15:05:00.000Z"
}
```

## 3. Conta Google

Use o Android Credential Manager com `GetGoogleIdOption`:

```kotlin
val googleIdOption = GetGoogleIdOption.Builder()
    .setFilterByAuthorizedAccounts(false)
    .setServerClientId(WEB_CLIENT_ID)
    .setNonce(nonce)
    .build()
```

O `WEB_CLIENT_ID` precisa ser o mesmo configurado no backend. Para impedir que o
usuário adicione uma conta no botão alternativo, ofereça apenas o seletor do
Credential Manager e defina a política de produto para falhar quando não houver
conta disponível. O backend ainda validará assinatura, audiência, validade,
nonce e `email_verified`.

## 4. Assinatura e Play Integrity

Assine os bytes UTF-8 abaixo usando `SHA256withECDSA`:

```text
{challengeId}.{nonce}
```

Para a solicitação padrão da Play Integrity, calcule:

```text
Base64UrlSemPadding(SHA-256(UTF8("auth:{challengeId}:{nonce}")))
```

Passe esse valor como `requestHash`. Envie o token retornado pela Play Integrity
sem decodificá-lo no app.

## 5. Concluir o login Google

`POST /v1/auth/google`

```json
{
  "challengeId": "3a5c7d96-ccef-49f5-8583-ed87d11fd329",
  "googleIdToken": "eyJ...",
  "devicePublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "deviceSignature": "assinatura-em-base64url-sem-padding",
  "integrityToken": "token-retornado-pela-play-integrity"
}
```

Conta nova: `nextStep` será `PROVIDE_PHONE`. Conta já cadastrada:
`AUTHENTICATED`.

## 6. Cadastrar o celular

Envie `Authorization: Bearer {registrationToken}`.

`POST /v1/registration/phone`

```json
{ "phone": "+5511999999999" }
```

O número é normalizado para o padrão internacional e precisa corresponder a um
celular válido. Como nenhuma mensagem é enviada, `phoneVerified` será `false`:
o backend não afirma que o número possui WhatsApp ou pertence ao usuário.

## 7. Renovar a sessão

Calcule o SHA-256 hexadecimal do refresh token e assine:

```text
refresh.{hashHexDoRefreshToken}.{timestampUnixEmMilissegundos}
```

`POST /v1/auth/refresh`

```json
{
  "refreshToken": "token-atual",
  "timestamp": 1782658800000,
  "deviceSignature": "assinatura-em-base64url-sem-padding"
}
```

Substitua imediatamente o refresh token antigo pelo novo retornado. Cada refresh
token pode ser usado uma única vez.
