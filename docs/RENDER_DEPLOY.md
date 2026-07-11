# Deploy do backend no Render

Este guia assume:

- backend em `Dockerfile`;
- PostgreSQL gerenciado pelo Render;
- URL pública HTTPS para a API;
- integração com Google, Play Integrity e RevenueCat.

## 1. Criar o banco

Crie um serviço PostgreSQL no Render e copie a `Internal Database URL`.
Use essa URL no backend como `DATABASE_URL`.

## 2. Criar o Web Service

Crie um Web Service apontando para o repositório do backend e selecione o
deploy por Docker.

## 3. Variáveis obrigatórias

Preencha estas variáveis no serviço da API:

```dotenv
NODE_ENV=production
TRUST_PROXY_HOPS=1
DATABASE_URL=
JWT_SECRET=
GOOGLE_WEB_CLIENT_ID=
REQUIRE_GMAIL_DOMAIN=true
ANDROID_PACKAGE_NAME=com.inrota.app
ANDROID_CERT_SHA256=
PLAY_INTEGRITY_ENABLED=true
PLAY_REQUIRE_LICENSED=true
REVENUECAT_WEBHOOK_AUTH_TOKEN=
REVENUECAT_SECRET_API_KEY=
REVENUECAT_ENTITLEMENT_ID=pro
ACCESS_TOKEN_TTL_SECONDS=900
REGISTRATION_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
```

## 4. Valores que ainda preciso de você

Me envie estes dados para eu deixar o projeto completo para produção:

- `JWT_SECRET`
- `GOOGLE_WEB_CLIENT_ID`
- `ANDROID_CERT_SHA256`
- `REVENUECAT_WEBHOOK_AUTH_TOKEN`
- `REVENUECAT_SECRET_API_KEY`
- confirmação se o login aceita só `@gmail.com` ou qualquer conta Google

## 5. Comando de inicialização

Use:

```bash
node dist/database/migrate.js && node dist/server.js
```

## 6. Validação

Depois do deploy, valide:

- `GET /health`
- login Google
- cadastro do celular
- assinatura
- refresh de sessão
