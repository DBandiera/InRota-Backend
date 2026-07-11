# Integração do app Android com o backend InRota

Este documento é o contrato atual entre:

- front: `E:\1Dev\in-rota-app`;
- backend: `E:\1Dev\in-rota-backend`;
- plataforma suportada nesta fase: Android.

## 1. Pré-requisitos e decisões

O app deve usar apenas login Google. A tela atual de e-mail e senha é
demonstrativa e deve ser substituída.

Use o mesmo identificador em todos os lugares:

```text
com.inrota.app
```

Ele precisa coincidir no `app.json`, projeto Google Cloud, Play Console e
`ANDROID_PACKAGE_NAME` do backend.

Configure no front:

```dotenv
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=000000000000-xxx.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER=000000000000
```

URLs locais:

- emulador Android: `http://10.0.2.2:3000`;
- aparelho físico: `http://IP_DO_COMPUTADOR:3000`;
- produção: somente HTTPS.

O Client ID utilizado no app é o OAuth Client ID do tipo **Web application**,
não o Client ID Android.

## 2. Necessidade de código nativo

O fluxo utiliza Credential Manager, Android Keystore e Play Integrity. Portanto,
não pode ser testado integralmente no Expo Go. O projeto precisa usar um
development build ou `expo run:android`.

O módulo nativo Android deve expor ao TypeScript funções equivalentes a:

```ts
type AndroidSecurity = {
  getOrCreateInstallationId(): Promise<string>;
  getOrCreateDevicePublicKeyPem(): Promise<string>;
  signWithDeviceKey(value: string): Promise<string>;
  signInWithGoogle(webClientId: string, nonce: string): Promise<string>;
  requestIntegrityToken(
    cloudProjectNumber: number,
    requestHash: string,
  ): Promise<string>;
};
```

Resultados das funções:

- chave: ECDSA P-256, criada no Android Keystore;
- chave pública: SPKI PEM;
- assinatura: `SHA256withECDSA`, codificada em Base64URL sem padding;
- login Google: ID token, não access token;
- Play Integrity: token opaco retornado pela solicitação padrão.

Nunca exporte a chave privada.

## 3. Estados do fluxo

```text
SEM_SESSÃO
   |
   v
CRIAR_DESAFIO
   |
   v
GOOGLE + CHAVE + INTEGRITY
   |
   +---- nextStep=PROVIDE_PHONE ---> INFORMAR_CELULAR
   |                                      |
   |                                      v
   +---- nextStep=AUTHENTICATED ----> AUTENTICADO
```

Um login novo exige celular. Um usuário já ativo recebe a sessão
imediatamente.

## 4. Formato comum de erros

```json
{
  "error": {
    "code": "INVALID_PHONE",
    "message": "Informe um número de celular válido, com DDD."
  }
}
```

Erros de validação podem incluir `details`.

Não tome decisões pela mensagem. O front deve usar `error.code`.

## 5. Criar desafio

### `POST /v1/auth/challenges`

Requisição:

```json
{
  "installationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

Resposta `201`:

```json
{
  "challengeId": "3a5c7d96-ccef-49f5-8583-ed87d11fd329",
  "nonce": "base64url-gerado-pelo-servidor",
  "expiresAt": "2026-06-28T15:05:00.000Z"
}
```

O desafio expira em cinco minutos e só pode ser usado uma vez.

## 6. Preparar a autenticação Android

### 6.1 Google

Abra o Credential Manager passando:

```kotlin
GetGoogleIdOption.Builder()
    .setFilterByAuthorizedAccounts(false)
    .setServerClientId(WEB_CLIENT_ID)
    .setNonce(nonce)
    .build()
```

Extraia `GoogleIdTokenCredential.idToken`.

### 6.2 Assinatura do aparelho

Monte exatamente:

```text
{challengeId}.{nonce}
```

Assine os bytes UTF-8 com a chave P-256 e devolva a assinatura em Base64URL sem
`=`.

### 6.3 Play Integrity

Monte exatamente:

```text
auth:{challengeId}:{nonce}
```

Calcule:

```text
Base64UrlSemPadding(SHA-256(UTF8(valor)))
```

Use o resultado como `requestHash` de uma solicitação padrão da Play Integrity.

Durante o desenvolvimento, o backend pode operar com
`PLAY_INTEGRITY_ENABLED=false`. Em produção o token é obrigatório.

## 7. Autenticar com Google

### `POST /v1/auth/google`

Requisição:

```json
{
  "challengeId": "3a5c7d96-ccef-49f5-8583-ed87d11fd329",
  "googleIdToken": "eyJhbGciOi...",
  "devicePublicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "deviceSignature": "base64url-sem-padding",
  "integrityToken": "token-opaco-play-integrity"
}
```

`integrityToken` é opcional apenas quando a validação está desligada no backend.

Resposta de cadastro novo `200`:

```json
{
  "nextStep": "PROVIDE_PHONE",
  "registrationToken": "eyJhbGciOi...",
  "user": {
    "id": "uuid",
    "email": "usuario@gmail.com",
    "name": "Usuário"
  }
}
```

Resposta de usuário já cadastrado `200`:

```json
{
  "nextStep": "AUTHENTICATED",
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "token-aleatorio",
  "expiresIn": 900,
  "user": {
    "id": "uuid",
    "email": "usuario@gmail.com",
    "name": "Usuário"
  }
}
```

## 8. Cadastrar celular

### `POST /v1/registration/phone`

Header:

```http
Authorization: Bearer REGISTRATION_TOKEN
Content-Type: application/json
```

Corpo:

```json
{
  "phone": "(11) 99999-9999"
}
```

Resposta `200`:

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "token-aleatorio",
  "expiresIn": 900,
  "phone": "+55*****9999",
  "phoneVerified": false
}
```

O backend:

- normaliza para E.164;
- exige número classificado como celular;
- rejeita telefone fixo;
- impede duplicidade entre contas;
- não confirma propriedade nem existência de WhatsApp.

O texto da tela não deve dizer “WhatsApp verificado”. Use algo como:

> Informe seu celular com WhatsApp para contato.

## 9. Armazenar a sessão

- `registrationToken`: somente em memória durante o cadastro;
- `accessToken`: memória ou armazenamento seguro, validade curta;
- `refreshToken`: armazenamento seguro;
- nunca use AsyncStorage para refresh token;
- nunca registre tokens, ID token, assinatura ou chave em logs.

Ao receber uma nova dupla de tokens, grave o novo refresh token antes de
descartar o anterior.

## 10. Renovar a sessão

Antes da requisição:

1. calcule o SHA-256 do refresh token;
2. represente o hash em hexadecimal minúsculo;
3. obtenha `Date.now()` em milissegundos;
4. monte e assine:

```text
refresh.{hashHexDoRefreshToken}.{timestamp}
```

### `POST /v1/auth/refresh`

```json
{
  "refreshToken": "token-atual",
  "timestamp": 1782658800000,
  "deviceSignature": "base64url-sem-padding"
}
```

Resposta `200`:

```json
{
  "accessToken": "novo-access-token",
  "refreshToken": "novo-refresh-token",
  "expiresIn": 900
}
```

Regras:

- tolerância do relógio: dois minutos;
- refresh token é rotacionado e só pode ser usado uma vez;
- implemente um mutex para impedir duas renovações simultâneas;
- em `INVALID_REFRESH_TOKEN`, `REFRESH_REPLAYED`,
  `INVALID_DEVICE_SIGNATURE` ou `STALE_SIGNATURE`, limpe a sessão e peça novo
  login.

### 10.1 Encerrar a sessão

### `POST /v1/auth/logout`

Header:

```http
Authorization: Bearer ACCESS_TOKEN
```

Resposta: `204` sem corpo.

O backend revoga todas as sessões abertas pelo usuário naquele aparelho. O app
deve tentar chamar este endpoint antes de apagar os tokens locais. Se estiver
sem conexão, o logout local ainda deve ser concluído.

## 11. Códigos que o front deve tratar

| Código | Ação sugerida |
|---|---|
| `VALIDATION_ERROR` | Marcar dados inválidos |
| `INVALID_CHALLENGE` | Reiniciar o login |
| `CHALLENGE_USED` | Reiniciar o login |
| `INVALID_GOOGLE_TOKEN` | Reabrir o login Google |
| `INVALID_GOOGLE_IDENTITY` | Reabrir o login Google |
| `GMAIL_REQUIRED` | Informar que somente `@gmail.com` é aceito |
| `INVALID_DEVICE_KEY` | Recriar a chave/instalação e tentar novamente |
| `INVALID_DEVICE_SIGNATURE` | Encerrar a sessão e refazer o vínculo |
| `INTEGRITY_REQUIRED` | Solicitar novo token Play Integrity |
| `INVALID_INTEGRITY_TOKEN` | Solicitar novo token Play Integrity |
| `INTEGRITY_REJECTED` | Bloquear o acesso e orientar instalação pela Play Store |
| `PROVIDE_PHONE` | Não é erro; abrir a tela de celular |
| `INVALID_PHONE` | Exibir erro no campo celular |
| `PHONE_ALREADY_USED` | Informar que o número já está associado |
| `TOKEN_REQUIRED` | Voltar ao login |
| `INVALID_TOKEN` | Voltar ao login ou renovar, conforme o token usado |
| `INVALID_REFRESH_TOKEN` | Limpar sessão e voltar ao login |
| `REFRESH_REPLAYED` | Limpar sessão e voltar ao login |
| `ACCOUNT_BLOCKED` | Bloquear entrada e exibir suporte |
| `INTERNAL_ERROR` | Mensagem genérica e opção de tentar novamente |

## 12. Organização sugerida no front

```text
src/
  config/
    authConfig.ts
  native/
    androidSecurity.ts
  services/
    apiClient.ts
    authApi.ts
    tokenStorage.ts
  store/
    authStore.ts
  screens/
    Auth/
      GoogleLoginScreen.tsx
      PhoneRegistrationScreen.tsx
```

O cliente HTTP deve:

- definir `baseURL` por `EXPO_PUBLIC_API_URL`;
- usar timeout;
- interpretar o envelope `error`;
- adicionar access token somente nas rotas protegidas;
- renovar uma única vez após `401`;
- impedir loop infinito de refresh.

## 13. Critérios de aceite

- não há campos de senha;
- login abre o seletor de conta Google do Android;
- nonce recebido do backend chega ao Credential Manager;
- chave privada nunca sai do Keystore;
- app envia Play Integrity quando habilitado;
- novo usuário é direcionado ao celular;
- celular fixo e inválido são rejeitados;
- usuário ativo entra sem repetir o celular;
- refresh sobrevive ao reinício do app;
- duas renovações simultâneas não corrompem a sessão;
- logout revoga a sessão do aparelho no backend;
- tokens nunca aparecem em logs.

## 14. Pendências externas

Antes do teste real:

1. disponibilizar PostgreSQL e executar `npm run db:migrate`;
2. criar os Client IDs OAuth Web e Android no Google Cloud;
3. configurar SHA-1/SHA-256 do certificado Android;
4. habilitar Play Integrity no Google Cloud/Play Console;
5. alterar o pacote do front de `com.anonymous.inrotaapp` para
   `com.inrota.app`;
6. preencher `.env` do backend e as variáveis públicas do front;
7. usar development build Android, não Expo Go.

## 15. Referências oficiais

- [Sign in with Google usando Credential Manager](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Solicitações padrão da Play Integrity](https://developer.android.com/google/play/integrity/standard)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [Development builds do Expo](https://docs.expo.dev/develop/development-builds/introduction/)
