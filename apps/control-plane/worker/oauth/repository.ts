export type OAuthClientRow = {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  status: "active" | "revoked";
};

export type OAuthTransactionInput = {
  id: string;
  stateHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  clientState: string;
  codeChallenge: string;
  humanIssuer: string;
  humanSubject: string;
  tenantId: string;
  membershipId: string;
  expiresAt: string;
  consentHash: string;
  createdAt: string;
};

export type OAuthCodeRow = {
  code_id: string;
  transaction_id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  human_issuer: string;
  human_subject: string;
  tenant_id: string;
  membership_id: string;
  transaction_expires_at: string;
  code_expires_at: string;
  consumed_at: string | null;
};

export type OAuthInstallationRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  human_issuer: string;
  human_subject: string;
  tenant_id: string;
  membership_id: string;
  principal_id: string;
  identity_id: string;
  status: "active" | "revoked";
  revoked_at: string | null;
};

export type OAuthUpstreamLoginRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  client_state: string;
  client_code_challenge: string;
  upstream_nonce: string;
  verifier_ciphertext: string;
  verifier_iv: string;
  tenant_hint: string | null;
  expires_at: string;
  completed_at: string | null;
};

export async function findOAuthClient(
  db: D1DatabaseSession,
  clientId: string,
  redirectUri: string,
): Promise<OAuthClientRow | null> {
  return db
    .prepare(
      "SELECT client_id, client_name, redirect_uri, status FROM oauth_clients WHERE client_id = ? AND redirect_uri = ? AND status = 'active' LIMIT 1",
    )
    .bind(clientId, redirectUri)
    .first<OAuthClientRow>();
}

export async function insertOAuthTransaction(
  db: D1DatabaseSession,
  input: OAuthTransactionInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_authorization_transactions
       (id, state_hash, client_id, redirect_uri, resource, scope,
        client_state, code_challenge, code_challenge_method, human_issuer,
        human_subject, tenant_id, membership_id, expires_at, consent_hash,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.stateHash,
      input.clientId,
      input.redirectUri,
      input.resource,
      input.scope,
      input.clientState,
      input.codeChallenge,
      input.humanIssuer,
      input.humanSubject,
      input.tenantId,
      input.membershipId,
      input.expiresAt,
      input.consentHash,
      input.createdAt,
    )
    .run();
}

export async function insertOAuthCode(
  db: D1DatabaseSession,
  input: {
    id: string;
    transactionId: string;
    codeHash: string;
    expiresAt: string;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_authorization_codes (id, transaction_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      input.id,
      input.transactionId,
      input.codeHash,
      input.expiresAt,
      input.createdAt,
    )
    .run();
}

export async function insertOAuthUpstreamLogin(
  db: D1DatabaseSession,
  input: {
    id: string;
    stateHash: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    clientState: string;
    clientCodeChallenge: string;
    upstreamNonce: string;
    verifierCiphertext: string;
    verifierIv: string;
    tenantHint: string | null;
    expiresAt: string;
    createdAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_upstream_login_transactions
       (id, state_hash, client_id, redirect_uri, resource, scope, client_state,
        client_code_challenge, upstream_nonce, verifier_ciphertext, verifier_iv,
        tenant_hint, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.stateHash,
      input.clientId,
      input.redirectUri,
      input.resource,
      input.scope,
      input.clientState,
      input.clientCodeChallenge,
      input.upstreamNonce,
      input.verifierCiphertext,
      input.verifierIv,
      input.tenantHint,
      input.expiresAt,
      input.createdAt,
    )
    .run();
}

export async function findOAuthUpstreamLogin(
  db: D1DatabaseSession,
  stateHash: string,
): Promise<OAuthUpstreamLoginRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, redirect_uri, resource, scope, client_state,
              client_code_challenge, upstream_nonce, verifier_ciphertext,
              verifier_iv, tenant_hint, expires_at, completed_at
       FROM oauth_upstream_login_transactions
       WHERE state_hash = ? LIMIT 1`,
    )
    .bind(stateHash)
    .first<OAuthUpstreamLoginRow>();
}

export async function completeOAuthUpstreamLogin(
  db: D1DatabaseSession,
  id: string,
  completedAt: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE oauth_upstream_login_transactions SET completed_at = ?, verifier_ciphertext = '', verifier_iv = '' WHERE id = ? AND completed_at IS NULL",
    )
    .bind(completedAt, id)
    .run();
}

export async function findOAuthCode(
  db: D1DatabaseSession,
  codeHash: string,
): Promise<OAuthCodeRow | null> {
  return db
    .prepare(
      `SELECT c.id AS code_id, c.transaction_id, c.expires_at AS code_expires_at,
              c.consumed_at, t.client_id, t.redirect_uri, t.resource, t.scope,
              t.code_challenge, t.human_issuer, t.human_subject, t.tenant_id,
              t.membership_id, t.expires_at AS transaction_expires_at
       FROM oauth_authorization_codes AS c
       JOIN oauth_authorization_transactions AS t ON t.id = c.transaction_id
       WHERE c.code_hash = ? LIMIT 1`,
    )
    .bind(codeHash)
    .first<OAuthCodeRow>();
}

export type OAuthTransactionRow = {
  id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  client_state: string;
  code_challenge: string;
  human_issuer: string;
  human_subject: string;
  tenant_id: string;
  membership_id: string;
  expires_at: string;
  consent_hash: string;
  consented_at: string | null;
  completed_at: string | null;
};

export async function findOAuthTransaction(
  db: D1DatabaseSession,
  id: string,
): Promise<OAuthTransactionRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, redirect_uri, resource, scope, client_state,
              code_challenge, human_issuer, human_subject, tenant_id,
              membership_id, expires_at, consent_hash, consented_at,
              completed_at
       FROM oauth_authorization_transactions WHERE id = ? LIMIT 1`,
    )
    .bind(id)
    .first<OAuthTransactionRow>();
}

export async function markOAuthConsent(
  db: D1DatabaseSession,
  id: string,
  consentedAt: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE oauth_authorization_transactions SET consented_at = ? WHERE id = ? AND consented_at IS NULL AND completed_at IS NULL",
    )
    .bind(consentedAt, id)
    .run();
}

export async function consumeOAuthCode(
  db: D1DatabaseSession,
  codeId: string,
  transactionId: string,
  consumedAt: string,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      "UPDATE oauth_authorization_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id",
    )
    .bind(consumedAt, codeId)
    .first<{ id: string }>();
  if (!claimed) return false;
  await db
    .prepare(
      "UPDATE oauth_authorization_transactions SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
    )
    .bind(consumedAt, transactionId)
    .run();
  return true;
}

export async function createOAuthInstallation(
  db: D1DatabaseSession,
  input: {
    installationId: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    humanIssuer: string;
    humanSubject: string;
    tenantId: string;
    membershipId: string;
    principalId: string;
    identityId: string;
    createdAt: string;
    asIssuer: string;
  },
): Promise<OAuthInstallationRow> {
  const statements = [
    db
      .prepare(
        `INSERT INTO principals
         (id, issuer, subject, principal_type, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'agent', ?, 'active', ?, ?)`,
      )
      .bind(
        input.principalId,
        input.asIssuer,
        input.installationId,
        `OAuth installation ${input.installationId}`,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO memberships
         (id, tenant_id, principal_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'member', 'active', ?, ?)`,
      )
      .bind(
        input.membershipId,
        input.tenantId,
        input.principalId,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO identities
         (id, tenant_id, identity_kind, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'agent', ?, 'active', ?, ?)`,
      )
      .bind(
        input.identityId,
        input.tenantId,
        `OAuth installation ${input.installationId}`,
        input.createdAt,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO identity_grants
         (tenant_id, membership_id, identity_id, operation_scope, created_at)
         VALUES (?, ?, ?, 'connection.read', ?), (?, ?, ?, 'conversation.read', ?)`,
      )
      .bind(
        input.tenantId,
        input.membershipId,
        input.identityId,
        input.createdAt,
        input.tenantId,
        input.membershipId,
        input.identityId,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO oauth_client_installations
         (id, client_id, redirect_uri, resource, human_issuer, human_subject,
          tenant_id, membership_id, principal_id, identity_id, status,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        input.installationId,
        input.clientId,
        input.redirectUri,
        input.resource,
        input.humanIssuer,
        input.humanSubject,
        input.tenantId,
        input.membershipId,
        input.principalId,
        input.identityId,
        input.createdAt,
        input.createdAt,
      ),
  ];
  await db.batch(statements);
  return {
    id: input.installationId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    resource: input.resource,
    human_issuer: input.humanIssuer,
    human_subject: input.humanSubject,
    tenant_id: input.tenantId,
    membership_id: input.membershipId,
    principal_id: input.principalId,
    identity_id: input.identityId,
    status: "active",
    revoked_at: null,
  };
}

export async function findActiveOAuthInstallation(
  db: D1DatabaseSession,
  installationId: string,
): Promise<OAuthInstallationRow | null> {
  return db
    .prepare(
      `SELECT id, client_id, redirect_uri, resource, human_issuer, human_subject,
              tenant_id, membership_id, principal_id, identity_id, status, revoked_at
       FROM oauth_client_installations
       WHERE id = ? AND status = 'active' AND revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(installationId)
    .first<OAuthInstallationRow>();
}
