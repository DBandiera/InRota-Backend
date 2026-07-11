# InRota Backend

API de cadastro e autenticação para o aplicativo Android, com:

- identidade validada pelo Google;
- opção de aceitar exclusivamente endereços `@gmail.com`;
- instalação vinculada a uma chave ECDSA P-256 criada no Android Keystore;
- verificação do app e do aparelho pela Play Integrity API;
- número de celular obrigatório antes da ativação da conta;
- access tokens curtos e refresh tokens rotativos;
- limitação de tentativas nos endpoints sensíveis.

## Fluxo

1. O app cria uma chave P-256 no Android Keystore e um `installationId` aleatório.
2. Chama `POST /v1/auth/challenges`.
3. Usa o `nonce` retornado no Credential Manager / Sign in with Google.
4. Assina `challengeId.nonce` com a chave do aparelho.
5. Solicita um token Play Integrity com o `requestHash` descrito abaixo.
6. Envia tudo para `POST /v1/auth/google`.
7. Um usuário novo recebe um `registrationToken` e informa o celular.
8. Depois do cadastro do número, recebe `accessToken` e `refreshToken`.

Veja os contratos e exemplos Android em
[docs/ANDROID_INTEGRATION.md](docs/ANDROID_INTEGRATION.md).

O contrato completo para implementação no front está em
[docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md).

## Executar localmente

Requisitos: Node.js 20+ e PostgreSQL 15+.

```bash
docker compose up -d
copy .env.example .env
```

Preencha pelo menos `GOOGLE_WEB_CLIENT_ID` e altere os dois segredos. Depois:

```bash
npm install
npm run db:migrate
npm run dev
```

## Ativação para produção

- Cadastre o app e sua impressão SHA-256 no Google Cloud e Play Console.
- Use no Android o Client ID OAuth do tipo Web em `setServerClientId`.
- Conceda à identidade do servidor acesso à Play Integrity API.
- Defina `PLAY_INTEGRITY_ENABLED=true` e a impressão em
  `ANDROID_CERT_SHA256`.
- Use PostgreSQL gerenciado, HTTPS e segredos em um cofre; nunca envie `.env`.
- Configure `TRUST_PROXY_HOPS` com a quantidade real de proxies da hospedagem.
- Use `GET /health` como verificação de prontidão da API e do PostgreSQL.
- Se for usar Render, siga [docs/RENDER_DEPLOY.md](docs/RENDER_DEPLOY.md).

### Imagem de produção

O `Dockerfile` gera uma imagem Node.js mínima, executada sem usuário root. Para
validar localmente a mesma imagem que será publicada:

```bash
docker build -t inrota-backend .
docker run --rm -p 3000:3000 --env-file .env inrota-backend
```

Para executar a migração e iniciar a API em sequência, crie
`.env.production` a partir de `.env.production.example` e use:

```bash
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

Em uma plataforma gerenciada, publique a imagem e configure o comando de
inicialização como:

```bash
node dist/database/migrate.js && node dist/server.js
```

O banco deve ser externo e persistente. Salve `JWT_SECRET` e as credenciais do
Google no gerenciador de segredos da hospedagem, nunca na imagem ou no Git.

## Limite importante

O Android não oferece ao backend uma prova de que uma conta Google já estava
configurada antes da instalação. O Credential Manager prova que o usuário
selecionou e autenticou uma conta disponível no fluxo. Play Integrity e a chave
do Android Keystore vinculam esse login a uma instalação legítima do app.

Sem enviar uma mensagem ou código, também não é tecnicamente possível comprovar
que o celular informado possui WhatsApp ou pertence ao usuário. O backend valida
o formato, exige um número móvel e impede que o mesmo número seja cadastrado em
duas contas, mas o mantém explicitamente como não verificado.
