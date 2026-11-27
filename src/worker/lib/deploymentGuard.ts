import { redactLogObject } from './logger';

export const EXPECTED_ARCHITECTURE_B_WORKER_NAME = 'auto-reply-bot';

export const DASHBOARD_MANAGED_VAR_KEYS = [
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_ADMIN_GROUP_ID',
  'SUPER_ADMIN_IDS',
] as const;

export const REQUIRED_STATIC_VAR_KEYS = [
  'ENVIRONMENT',
  'OFFICIAL_CHANNEL_URL',
  'GEMINI_MODEL',
  'APP_TIMEZONE',
  'RETENTION_MESSAGES_DAYS',
  'RETENTION_FINGERPRINTS_DAYS',
  'RETENTION_AUDIT_DAYS',
  'RETENTION_WITHDRAWAL_PII_DAYS',
  'RETENTION_OUTBOX_DAYS',
  'ENCRYPTION_KEY_VERSION',
] as const;

export const REQUIRED_SECRET_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'WITHDRAWAL_PII_ENCRYPTION_KEY',
] as const;

export const OPTIONAL_ROTATION_SECRET_KEYS = [
  'TELEGRAM_WEBHOOK_SECRET_PREVIOUS',
  'WITHDRAWAL_PII_ENCRYPTION_KEY_PREVIOUS',
] as const;

export const EXPECTED_CRON_TRIGGERS = [
  '* * * * *',
  '*/5 * * * *',
  '0 20 * * *',
] as const;

const PLACEHOLDER_VALUE_PATTERNS: readonly RegExp[] = [
  /^CONFIGURED_IN_CLOUDFLARE_ENV$/i,
  /^PENDING_OWNER_CONFIRMATION$/i,
  /^PENDING_OWNER_CONFIGURATION$/i,
  /^REPLACE_ME/i,
  /^CHANGE_ME/i,
  /^CHANGEME/i,
  /^TODO/i,
  /^EXAMPLE/i,
  /^YOUR_/i,
  /^<[^>]+>$/,
];

const PLACEHOLDER_UUID_PATTERNS: readonly RegExp[] = [
  /^00000000-0000-0000-0000-00000000000[0-9a-f]$/i,
  /^00000000-0000-[0-9a-f]{4}-[0-9a-f]{4}-00000000000[0-9a-f]$/i,
  /^deadbeef-/i,
  /^0+$/,
  /^<[^>]+>$/,
  /placeholder/i,
];

const UUID_FORMAT_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WranglerD1BindingConfig {
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
}

export interface WranglerQueueProducerConfig {
  binding?: string;
  queue?: string;
}

export interface WranglerQueueConsumerConfig {
  queue?: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  max_concurrency?: number;
  dead_letter_queue?: string;
}

export interface WranglerEnvironmentScopeConfig {
  name?: string;
  keep_vars?: boolean;
  triggers?: {
    crons?: string[];
  };
  vars?: Record<string, unknown>;
  d1_databases?: WranglerD1BindingConfig[];
  queues?: {
    producers?: WranglerQueueProducerConfig[];
    consumers?: WranglerQueueConsumerConfig[];
  };
}

export interface WranglerRootConfig extends WranglerEnvironmentScopeConfig {
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  env?: Record<string, WranglerEnvironmentScopeConfig>;
}

export type DeploymentTargetSelection = 'top-level' | 'staging' | 'production' | string;
export type DeploymentPhaseMode = 'temporary_staging' | 'production_authorized';

export interface ExternalStagingResourceVerification {
  d1DatabaseProvisioned?: boolean;
  d1MigrationsApplied?: boolean;
  primaryQueueProvisioned?: boolean;
  dlqProvisioned?: boolean;
}

export interface ExternalSecretVerification {
  verifiedEncryptedSecretKeys?: readonly string[];
  historicalPlaintextSecretsCleared?: boolean;
}

export interface ExternalAdminNotificationVerification {
  dashboardVarsConfigured?: boolean;
  adminGroupVerified?: boolean;
  activeStartedSuperAdminVerified?: boolean;
  configuredAdminGroupId?: string;
  configuredSuperAdminIds?: string;
}

export interface ExternalDeploymentVerification {
  stagingResources?: ExternalStagingResourceVerification;
  secrets?: ExternalSecretVerification;
  adminNotification?: ExternalAdminNotificationVerification;
}

export interface DeploymentGuardOptions {
  targetEnv?: DeploymentTargetSelection;
  phaseMode?: DeploymentPhaseMode;
  ciOverrideName?: string;
  envExampleContent?: string;
  dashboardPlaintextBindingKeys?: string[];
  externalVerification?: ExternalDeploymentVerification;
  explicitOwnerAuthorization?: boolean;
  acknowledgeLiveWorkerReplacementRisk?: boolean;
  requireExplicitAuthorization?: boolean;
}

export type DeploymentGuardIssueCode =
  | 'INVALID_CONFIG_OBJECT'
  | 'INCONSISTENT_WORKER_IDENTITY'
  | 'ROOT_STAGING_WORKER_IDENTITY_COLLISION'
  | 'LIVE_WORKER_REPLACEMENT_RISK_UNACKNOWLEDGED'
  | 'MISSING_TOP_LEVEL_KEEP_VARS'
  | 'INVALID_NAMED_ENV_KEEP_VARS'
  | 'INVALID_TARGET_ENVIRONMENT'
  | 'PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE'
  | 'TOP_LEVEL_NOT_STAGING_IN_ARCHITECTURE_B'
  | 'CI_OVERRIDE_NAME_MISMATCH'
  | 'DASHBOARD_MANAGED_VAR_IN_WRANGLER_VARS'
  | 'PLACEHOLDER_VAR_VALUE'
  | 'SECRET_IN_PLAINTEXT_VARS'
  | 'HISTORICAL_PLAINTEXT_SECRET_BINDING'
  | 'UNCONSUMED_OR_UNKNOWN_VAR'
  | 'MISSING_STATIC_VAR'
  | 'MISSING_D1_BINDING'
  | 'PLACEHOLDER_D1_DATABASE_ID'
  | 'INVALID_D1_DATABASE_ID'
  | 'STAGING_TOP_LEVEL_ENV_MISMATCH'
  | 'STAGING_PRODUCTION_RESOURCE_COLLISION'
  | 'MISSING_QUEUE_PRODUCER'
  | 'MISSING_PRIMARY_QUEUE_CONSUMER'
  | 'MISSING_DLQ_CONSUMER'
  | 'INVALID_DLQ_CONFIGURATION'
  | 'MISSING_CRON_TRIGGERS'
  | 'MISSING_SECRET_DECLARATION'
  | 'NON_EMPTY_SECRET_IN_ENV_EXAMPLE'
  | 'UNVERIFIED_EXTERNAL_STAGING_RESOURCES'
  | 'UNVERIFIED_EXTERNAL_SECRETS'
  | 'UNVERIFIED_ADMIN_NOTIFICATION_ROUTE'
  | 'DEPLOYMENT_NOT_AUTHORIZED';

export interface DeploymentGuardIssue {
  code: DeploymentGuardIssueCode;
  scope: string;
  message: string;
}

export interface DeploymentGuardResult {
  /**
   * 1. Local configuration structure & policy validity (wrangler.jsonc + .env.example).
   * Note: A local check is strictly advisory and CANNOT prevent an externally configured Cloudflare Workers Builds pipeline from running.
   */
  localConfigValid: boolean;
  /**
   * 2. External Cloudflare staging resource readiness (requires real D1 UUID in wrangler.jsonc AND verified remote D1 + migrations + primary Queue + DLQ).
   */
  stagingResourceReady: boolean;
  /**
   * 3. External Secret configuration readiness (requires zero plaintext secret leaks AND explicit verification of all 4 required Cloudflare Secrets).
   */
  secretConfigReady: boolean;
  /**
   * 4. Admin notification route readiness (requires verified Dashboard routing variables and at least one verified admin notification route / started SUPER_ADMIN).
   */
  adminNotificationReady: boolean;
  /**
   * 5. Deployment authorization (never true automatically; requires all 4 readiness states + explicitOwnerAuthorization + live-worker replacement risk acknowledgment when targeting auto-reply-bot).
   */
  deploymentAuthorized: boolean;
  /**
   * Aggregate readiness flag (true only when localConfigValid, stagingResourceReady, secretConfigReady, and adminNotificationReady are all true, plus deploymentAuthorized when requireExplicitAuthorization is true).
   */
  readyToDeploy: boolean;
  /**
   * True when the resolved deployment target is the existing live Worker "auto-reply-bot" under temporary_staging mode, which would replace the currently deployed live Worker receiving 100% traffic.
   */
  liveWorkerReplacementRisk: boolean;
  /**
   * Explicit boundary reminder that this guard is a local repository check only, not Cloudflare IAM or a remote CI/CD lock.
   */
  advisoryScope: 'LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK';
  resolvedWorkerName: string | null;
  targetEnv: string;
  phaseMode: DeploymentPhaseMode;
  issues: DeploymentGuardIssue[];
}

export function isPlaceholderD1DatabaseId(databaseId: unknown): boolean {
  if (typeof databaseId !== 'string') return true;
  const trimmed = databaseId.trim();
  if (!trimmed) return true;
  for (const pattern of PLACEHOLDER_UUID_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(trimmed)) {
    return true;
  }
  // Reject trivial single-repeated-character synthetic UUIDs (e.g. 11111111-1111-4111-8111-111111111111)
  const hexOnly = trimmed.replace(/-/g, '').toLowerCase();
  if (hexOnly.length === 32 && new Set(hexOnly.split('')).size <= 2) {
    return true;
  }
  return false;
}

export function isValidD1DatabaseUuid(databaseId: unknown): boolean {
  if (typeof databaseId !== 'string') return false;
  const trimmed = databaseId.trim();
  if (isPlaceholderD1DatabaseId(trimmed)) return false;
  return UUID_FORMAT_REGEX.test(trimmed);
}

export function isPlaceholderVarValue(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function validateVarsBlock(
  scopeName: string,
  vars: Record<string, unknown> | undefined,
  expectedEnvironmentValue: 'staging' | 'production',
  issues: DeploymentGuardIssue[]
): void {
  if (!vars || typeof vars !== 'object') {
    issues.push({
      code: 'MISSING_STATIC_VAR',
      scope: scopeName,
      message: `[${scopeName}] Missing "vars" block in Wrangler configuration.`,
    });
    return;
  }

  const secretKeySet = new Set<string>([
    ...REQUIRED_SECRET_KEYS,
    ...OPTIONAL_ROTATION_SECRET_KEYS,
  ]);
  const dashboardKeySet = new Set<string>(DASHBOARD_MANAGED_VAR_KEYS);
  const staticKeySet = new Set<string>(REQUIRED_STATIC_VAR_KEYS);

  for (const [key, rawValue] of Object.entries(vars)) {
    const isSecretKey = secretKeySet.has(key);
    const isDashboardKey = dashboardKeySet.has(key);
    const isStaticKey = staticKeySet.has(key);

    if (isSecretKey) {
      issues.push({
        code: 'SECRET_IN_PLAINTEXT_VARS',
        scope: scopeName,
        message: `[${scopeName}] Secret "${key}" must never be placed in plaintext Wrangler "vars". Configure it strictly as an encrypted Cloudflare Secret.`,
      });
    }

    if (isDashboardKey) {
      issues.push({
        code: 'DASHBOARD_MANAGED_VAR_IN_WRANGLER_VARS',
        scope: scopeName,
        message: `[${scopeName}] Dashboard-managed variable "${key}" must be omitted from Wrangler "vars" so Wrangler does not overwrite its Cloudflare Dashboard value on deploy.`,
      });
    }

    if (!isSecretKey && !isDashboardKey && !isStaticKey) {
      issues.push({
        code: 'UNCONSUMED_OR_UNKNOWN_VAR',
        scope: scopeName,
        message: `[${scopeName}] Unknown or unconsumed variable "${key}" is present in Wrangler "vars" but not declared in the Worker Env contract.`,
      });
    }

    if (isPlaceholderVarValue(rawValue)) {
      issues.push({
        code: 'PLACEHOLDER_VAR_VALUE',
        scope: scopeName,
        message: `[${scopeName}] Variable "${key}" contains an unresolved placeholder or empty value.`,
      });
    }
  }

  for (const requiredKey of REQUIRED_STATIC_VAR_KEYS) {
    const val = vars[requiredKey];
    if (typeof val !== 'string' || val.trim().length === 0) {
      issues.push({
        code: 'MISSING_STATIC_VAR',
        scope: scopeName,
        message: `[${scopeName}] Missing required static variable "${requiredKey}" in "vars".`,
      });
    }
  }

  if (vars.ENVIRONMENT !== expectedEnvironmentValue) {
    if (scopeName === 'top-level' && expectedEnvironmentValue === 'staging') {
      issues.push({
        code: 'TOP_LEVEL_NOT_STAGING_IN_ARCHITECTURE_B',
        scope: scopeName,
        message: `[${scopeName}] Temporary Architecture B requires top-level vars.ENVIRONMENT to be "staging" (found "${String(vars.ENVIRONMENT ?? '')}").`,
      });
    } else {
      issues.push({
        code: 'MISSING_STATIC_VAR',
        scope: scopeName,
        message: `[${scopeName}] Expected vars.ENVIRONMENT to be "${expectedEnvironmentValue}" (found "${String(vars.ENVIRONMENT ?? '')}").`,
      });
    }
  }
}

function validateScopeBindings(
  scopeName: string,
  scopeCfg: WranglerEnvironmentScopeConfig,
  issues: DeploymentGuardIssue[]
): void {
  // 1. Validate Cron Triggers
  const crons = scopeCfg.triggers?.crons;
  if (!Array.isArray(crons) || EXPECTED_CRON_TRIGGERS.some((c) => !crons.includes(c))) {
    issues.push({
      code: 'MISSING_CRON_TRIGGERS',
      scope: scopeName,
      message: `[${scopeName}] Missing required cron triggers (${EXPECTED_CRON_TRIGGERS.join(', ')}).`,
    });
  }

  // 2. Validate D1 Database binding
  const d1List = scopeCfg.d1_databases;
  if (!Array.isArray(d1List) || d1List.length === 0) {
    issues.push({
      code: 'MISSING_D1_BINDING',
      scope: scopeName,
      message: `[${scopeName}] Missing "d1_databases" configuration.`,
    });
  } else {
    const dbBindings = d1List.filter((d) => d.binding === 'DB');
    if (dbBindings.length === 0) {
      issues.push({
        code: 'MISSING_D1_BINDING',
        scope: scopeName,
        message: `[${scopeName}] Missing D1 database with binding "DB".`,
      });
    } else {
      if (dbBindings.length > 1) {
        issues.push({
          code: 'MISSING_D1_BINDING',
          scope: scopeName,
          message: `[${scopeName}] Duplicate D1 bindings named "DB" found.`,
        });
      }
      const dbBinding = dbBindings[0];
      if (!dbBinding.database_name || !dbBinding.database_name.trim()) {
        issues.push({
          code: 'MISSING_D1_BINDING',
          scope: scopeName,
          message: `[${scopeName}] D1 binding "DB" is missing "database_name".`,
        });
      }
      if (dbBinding.migrations_dir !== 'migrations') {
        issues.push({
          code: 'MISSING_D1_BINDING',
          scope: scopeName,
          message: `[${scopeName}] D1 binding "DB" must declare "migrations_dir": "migrations".`,
        });
      }
      if (isPlaceholderD1DatabaseId(dbBinding.database_id)) {
        issues.push({
          code: 'PLACEHOLDER_D1_DATABASE_ID',
          scope: scopeName,
          message: `[${scopeName}] D1 binding "DB" ("${dbBinding.database_name ?? 'unknown'}") still contains placeholder database_id "${String(dbBinding.database_id ?? '')}". Supply a real Cloudflare D1 UUID before deploying.`,
        });
      } else if (!isValidD1DatabaseUuid(dbBinding.database_id)) {
        issues.push({
          code: 'INVALID_D1_DATABASE_ID',
          scope: scopeName,
          message: `[${scopeName}] D1 binding "DB" has malformed UUID database_id "${String(dbBinding.database_id ?? '')}".`,
        });
      }
    }
  }

  // 3. Validate Queue Producer & Consumers
  const producers = scopeCfg.queues?.producers;
  const consumers = scopeCfg.queues?.consumers;

  if (!Array.isArray(producers) || producers.length === 0) {
    issues.push({
      code: 'MISSING_QUEUE_PRODUCER',
      scope: scopeName,
      message: `[${scopeName}] Missing "queues.producers" configuration.`,
    });
    return;
  }

  const outboxProducer = producers.find((p) => p.binding === 'OUTBOX_QUEUE');
  if (!outboxProducer || !outboxProducer.queue || !outboxProducer.queue.trim()) {
    issues.push({
      code: 'MISSING_QUEUE_PRODUCER',
      scope: scopeName,
      message: `[${scopeName}] Missing Queue producer with binding "OUTBOX_QUEUE" and a non-empty queue name.`,
    });
    return;
  }

  if (!Array.isArray(consumers) || consumers.length === 0) {
    issues.push({
      code: 'MISSING_PRIMARY_QUEUE_CONSUMER',
      scope: scopeName,
      message: `[${scopeName}] Missing "queues.consumers" configuration.`,
    });
    return;
  }

  const primaryConsumer = consumers.find((c) => c.queue === outboxProducer.queue);
  if (!primaryConsumer) {
    issues.push({
      code: 'MISSING_PRIMARY_QUEUE_CONSUMER',
      scope: scopeName,
      message: `[${scopeName}] Missing primary Queue consumer matching producer queue "${outboxProducer.queue}".`,
    });
    return;
  }

  if (!primaryConsumer.dead_letter_queue || !primaryConsumer.dead_letter_queue.trim()) {
    issues.push({
      code: 'MISSING_DLQ_CONSUMER',
      scope: scopeName,
      message: `[${scopeName}] Primary Queue consumer "${outboxProducer.queue}" must configure "dead_letter_queue".`,
    });
    return;
  }

  const dlqName = primaryConsumer.dead_letter_queue;
  if (!dlqName.toLowerCase().includes('dlq')) {
    issues.push({
      code: 'INVALID_DLQ_CONFIGURATION',
      scope: scopeName,
      message: `[${scopeName}] Dead-letter queue name "${dlqName}" must contain "dlq" to match src/worker/index.ts queue routing logic.`,
    });
  }

  const dlqConsumer = consumers.find((c) => c.queue === dlqName);
  if (!dlqConsumer) {
    issues.push({
      code: 'MISSING_DLQ_CONSUMER',
      scope: scopeName,
      message: `[${scopeName}] Missing explicit DLQ consumer binding for dead_letter_queue "${dlqName}".`,
    });
  } else if (dlqConsumer.max_retries !== 0) {
    issues.push({
      code: 'INVALID_DLQ_CONFIGURATION',
      scope: scopeName,
      message: `[${scopeName}] DLQ consumer "${dlqName}" must set "max_retries": 0 to prevent infinite DLQ retry loops.`,
    });
  }
}

function validateCrossEnvironmentConsistency(
  cfg: WranglerRootConfig,
  issues: DeploymentGuardIssue[]
): void {
  const topD1 = cfg.d1_databases?.find((d) => d.binding === 'DB');
  const topProducer = cfg.queues?.producers?.find((p) => p.binding === 'OUTBOX_QUEUE');
  const topPrimaryConsumer = cfg.queues?.consumers?.find((c) => c.queue === topProducer?.queue);

  // 1. Ensure top-level temporary staging and env.staging do not diverge on D1 or Queue resource names/IDs
  const stagingEnv = cfg.env?.staging;
  if (stagingEnv) {
    const stgD1 = stagingEnv.d1_databases?.find((d) => d.binding === 'DB');
    const stgProducer = stagingEnv.queues?.producers?.find((p) => p.binding === 'OUTBOX_QUEUE');
    const stgPrimaryConsumer = stagingEnv.queues?.consumers?.find(
      (c) => c.queue === stgProducer?.queue
    );

    if (
      topD1 &&
      stgD1 &&
      (topD1.database_name !== stgD1.database_name || topD1.database_id !== stgD1.database_id)
    ) {
      issues.push({
        code: 'STAGING_TOP_LEVEL_ENV_MISMATCH',
        scope: 'env.staging',
        message: `[env.staging] D1 binding "DB" (${stgD1.database_name} / ${stgD1.database_id}) diverges from top-level temporary staging D1 (${topD1.database_name} / ${topD1.database_id}). Keep both synchronized under Architecture B.`,
      });
    }

    if (
      topProducer &&
      stgProducer &&
      (topProducer.queue !== stgProducer.queue ||
        topPrimaryConsumer?.dead_letter_queue !== stgPrimaryConsumer?.dead_letter_queue)
    ) {
      issues.push({
        code: 'STAGING_TOP_LEVEL_ENV_MISMATCH',
        scope: 'env.staging',
        message: `[env.staging] Queue configuration (${stgProducer.queue} / ${stgPrimaryConsumer?.dead_letter_queue ?? ''}) diverges from top-level temporary staging Queue (${topProducer.queue} / ${topPrimaryConsumer?.dead_letter_queue ?? ''}).`,
      });
    }
  }

  // 2. Ensure staging (top-level or env.staging) never collides with env.production D1 or Queue resources
  const prodEnv = cfg.env?.production;
  if (prodEnv) {
    const prodD1 = prodEnv.d1_databases?.find((d) => d.binding === 'DB');
    const prodProducer = prodEnv.queues?.producers?.find((p) => p.binding === 'OUTBOX_QUEUE');
    const prodPrimaryConsumer = prodEnv.queues?.consumers?.find(
      (c) => c.queue === prodProducer?.queue
    );

    if (topD1 && prodD1) {
      if (topD1.database_name && topD1.database_name === prodD1.database_name) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `Staging and Production D1 bindings share the same database_name "${topD1.database_name}". Staging and Production databases must be strictly isolated.`,
        });
      }
      if (
        !isPlaceholderD1DatabaseId(topD1.database_id) &&
        !isPlaceholderD1DatabaseId(prodD1.database_id) &&
        topD1.database_id === prodD1.database_id
      ) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `Staging and Production D1 bindings share the same database_id "${String(topD1.database_id)}". Staging and Production databases must be strictly isolated.`,
        });
      }
    }

    if (topProducer && prodProducer) {
      if (topProducer.queue && topProducer.queue === prodProducer.queue) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `Staging and Production OUTBOX_QUEUE bindings share the same queue "${topProducer.queue}".`,
        });
      }
      if (
        topPrimaryConsumer?.dead_letter_queue &&
        topPrimaryConsumer.dead_letter_queue === prodPrimaryConsumer?.dead_letter_queue
      ) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `Staging and Production dead_letter_queue share the same queue "${topPrimaryConsumer.dead_letter_queue}".`,
        });
      }
    }
  }
}

export function validateWranglerDeploymentConfig(
  rawConfig: unknown,
  options: DeploymentGuardOptions = {}
): DeploymentGuardResult {
  const targetEnv = options.targetEnv ?? 'top-level';
  const phaseMode: DeploymentPhaseMode = options.phaseMode ?? 'temporary_staging';
  const issues: DeploymentGuardIssue[] = [];

  if (!rawConfig || typeof rawConfig !== 'object') {
    return {
      localConfigValid: false,
      stagingResourceReady: false,
      secretConfigReady: false,
      adminNotificationReady: false,
      deploymentAuthorized: false,
      readyToDeploy: false,
      liveWorkerReplacementRisk: false,
      advisoryScope: 'LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK',
      resolvedWorkerName: null,
      targetEnv,
      phaseMode,
      issues: [
        {
          code: 'INVALID_CONFIG_OBJECT',
          scope: 'root',
          message: 'Wrangler configuration is missing or not a valid JSON object.',
        },
      ],
    };
  }

  const cfg = rawConfig as WranglerRootConfig;
  const baseName = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : null;

  // 0. Architecture B Worker identity check
  if (phaseMode === 'temporary_staging' && baseName !== EXPECTED_ARCHITECTURE_B_WORKER_NAME) {
    issues.push({
      code: 'INCONSISTENT_WORKER_IDENTITY',
      scope: 'top-level',
      message: `Top-level Worker name must be "${EXPECTED_ARCHITECTURE_B_WORKER_NAME}" under Architecture B temporary staging mode (found "${String(cfg.name ?? '')}").`,
    });
  }

  // Detect explicit env.staging.name collision with top-level Worker name
  if (
    baseName &&
    typeof cfg.env?.staging?.name === 'string' &&
    cfg.env.staging.name.trim() === baseName
  ) {
    issues.push({
      code: 'ROOT_STAGING_WORKER_IDENTITY_COLLISION',
      scope: 'env.staging',
      message: `[env.staging] Explicit "name": "${baseName}" collides with top-level Worker name "${baseName}" and breaks Wrangler named-environment suffix conventions ("${baseName}-staging"). Omit "env.staging.name" so Wrangler derives "${baseName}-staging" cleanly.`,
    });
  }

  // 1. Top-level keep_vars check
  if (cfg.keep_vars !== true) {
    issues.push({
      code: 'MISSING_TOP_LEVEL_KEEP_VARS',
      scope: 'top-level',
      message:
        'Top-level "keep_vars": true is required in wrangler.jsonc so Dashboard-managed variables are preserved on deploy.',
    });
  }

  // 2. Ensure keep_vars is NOT placed inside named environments
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [envKey, envObj] of Object.entries(cfg.env)) {
      if (envObj && typeof envObj === 'object' && 'keep_vars' in envObj) {
        issues.push({
          code: 'INVALID_NAMED_ENV_KEEP_VARS',
          scope: `env.${envKey}`,
          message: `[env.${envKey}] "keep_vars" is a top-level Wrangler property only and must not be placed inside "env.${envKey}".`,
        });
      }
    }
  }

  // 3. Validate all vars blocks across top-level, env.staging, and env.production
  validateVarsBlock('top-level', cfg.vars, 'staging', issues);
  if (cfg.env?.staging) {
    validateVarsBlock('env.staging', cfg.env.staging.vars, 'staging', issues);
  }
  if (cfg.env?.production) {
    validateVarsBlock('env.production', cfg.env.production.vars, 'production', issues);
  }

  // 4. Target environment selection & phase mode guard
  const allowedTargets = new Set(['top-level', 'staging', 'production']);
  if (!allowedTargets.has(targetEnv)) {
    issues.push({
      code: 'INVALID_TARGET_ENVIRONMENT',
      scope: targetEnv,
      message: `Invalid target environment "${targetEnv}". Allowed targets: top-level, staging, production.`,
    });
    return {
      localConfigValid: false,
      stagingResourceReady: false,
      secretConfigReady: false,
      adminNotificationReady: false,
      deploymentAuthorized: false,
      readyToDeploy: false,
      liveWorkerReplacementRisk: false,
      advisoryScope: 'LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK',
      resolvedWorkerName: null,
      targetEnv,
      phaseMode,
      issues,
    };
  }

  if (targetEnv === 'production' && phaseMode === 'temporary_staging') {
    issues.push({
      code: 'PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE',
      scope: 'env.production',
      message:
        'Accidental production deployment blocked: repository is currently locked in Architecture B temporary staging mode.',
    });
  }

  let activeScopeName = 'top-level';
  let activeScope: WranglerEnvironmentScopeConfig = cfg;
  let resolvedWorkerName: string | null = baseName;

  if (targetEnv !== 'top-level') {
    activeScopeName = `env.${targetEnv}`;
    const namedScope = cfg.env?.[targetEnv];
    if (!namedScope) {
      issues.push({
        code: 'INVALID_TARGET_ENVIRONMENT',
        scope: activeScopeName,
        message: `Named environment "${activeScopeName}" is not defined in wrangler.jsonc.`,
      });
      return {
        localConfigValid: false,
        stagingResourceReady: false,
        secretConfigReady: false,
        adminNotificationReady: false,
        deploymentAuthorized: false,
        readyToDeploy: false,
        liveWorkerReplacementRisk: false,
        advisoryScope: 'LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK',
        resolvedWorkerName: null,
        targetEnv,
        phaseMode,
        issues,
      };
    }
    activeScope = namedScope;
    resolvedWorkerName =
      typeof namedScope.name === 'string' && namedScope.name.trim()
        ? namedScope.name.trim()
        : baseName
          ? `${baseName}-${targetEnv}`
          : null;
  }

  // 5. WRANGLER_CI_OVERRIDE_NAME interaction check
  if (options.ciOverrideName !== undefined && options.ciOverrideName.trim().length > 0) {
    const override = options.ciOverrideName.trim();
    if (targetEnv !== 'top-level') {
      if (!override.endsWith(`-${targetEnv}`)) {
        issues.push({
          code: 'CI_OVERRIDE_NAME_MISMATCH',
          scope: activeScopeName,
          message: `WRANGLER_CI_OVERRIDE_NAME="${override}" is incompatible with "--env ${targetEnv}" because Wrangler requires the override name to end with "-${targetEnv}" (or overrides the target back to "${override}").`,
        });
      } else {
        resolvedWorkerName = override;
      }
    } else if (baseName && override !== baseName) {
      issues.push({
        code: 'CI_OVERRIDE_NAME_MISMATCH',
        scope: 'top-level',
        message: `WRANGLER_CI_OVERRIDE_NAME="${override}" does not match top-level Worker name "${baseName}".`,
      });
    } else {
      resolvedWorkerName = override;
    }
  }

  // 6. Validate bindings on the selected target scope + cross-environment consistency
  validateScopeBindings(activeScopeName, activeScope, issues);
  validateCrossEnvironmentConsistency(cfg, issues);

  // 7. Optional .env.example secret declaration check (verifies names & empty values only, never real secrets)
  if (typeof options.envExampleContent === 'string') {
    for (const secretName of [...REQUIRED_SECRET_KEYS, ...OPTIONAL_ROTATION_SECRET_KEYS]) {
      const declMatch = new RegExp(`^#?\\s*${secretName}=(.*)$`, 'm').exec(
        options.envExampleContent
      );
      if (!declMatch) {
        issues.push({
          code: 'MISSING_SECRET_DECLARATION',
          scope: '.env.example',
          message: `[.env.example] Missing secret declaration template for "${secretName}".`,
        });
      } else {
        const rhs = declMatch[1].trim();
        if (rhs.length > 0 && !/^<[^>]+>$/.test(rhs)) {
          issues.push({
            code: 'NON_EMPTY_SECRET_IN_ENV_EXAMPLE',
            scope: '.env.example',
            message: `[.env.example] Secret key "${secretName}" must have an empty value or angle-bracket template in .env.example.`,
          });
        }
      }
    }
  }

  // 8. Check for historical plaintext credential bindings on the Dashboard (which keep_vars: true would preserve)
  if (Array.isArray(options.dashboardPlaintextBindingKeys)) {
    const secretKeySet = new Set<string>([
      ...REQUIRED_SECRET_KEYS,
      ...OPTIONAL_ROTATION_SECRET_KEYS,
    ]);
    for (const key of options.dashboardPlaintextBindingKeys) {
      if (secretKeySet.has(key)) {
        issues.push({
          code: 'HISTORICAL_PLAINTEXT_SECRET_BINDING',
          scope: 'cloudflare-dashboard',
          message: `[cloudflare-dashboard] Secret "${key}" exists as a plaintext variable in Cloudflare Dashboard. Because "keep_vars: true" preserves existing plaintext bindings without converting them, delete the plaintext binding and recreate "${key}" as an encrypted Secret.`,
        });
      }
    }
  }

  // Evaluate localConfigValid before checking external verification evidence
  const localResourcePlaceholderCodes = new Set<DeploymentGuardIssueCode>([
    'PLACEHOLDER_D1_DATABASE_ID',
  ]);
  const externalOnlyIssueCodes = new Set<DeploymentGuardIssueCode>([
    'HISTORICAL_PLAINTEXT_SECRET_BINDING',
    'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
    'UNVERIFIED_EXTERNAL_SECRETS',
    'UNVERIFIED_ADMIN_NOTIFICATION_ROUTE',
    'LIVE_WORKER_REPLACEMENT_RISK_UNACKNOWLEDGED',
    'DEPLOYMENT_NOT_AUTHORIZED',
  ]);

  const localConfigIssues = issues.filter(
    (i) => !localResourcePlaceholderCodes.has(i.code) && !externalOnlyIssueCodes.has(i.code)
  );
  const localConfigValid = localConfigIssues.length === 0;

  // 9. External Cloudflare Staging Resource Verification (never defaults to true on empty object)
  const extStaging = options.externalVerification?.stagingResources;
  const externalResourcesVerified =
    extStaging !== undefined &&
    extStaging.d1DatabaseProvisioned === true &&
    extStaging.d1MigrationsApplied === true &&
    extStaging.primaryQueueProvisioned === true &&
    extStaging.dlqProvisioned === true;

  if (!externalResourcesVerified) {
    issues.push({
      code: 'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
      scope: 'cloudflare-external',
      message:
        '[cloudflare-external] External staging resources (D1 database vip-gaming-d1-staging, 5 remote D1 migrations, primary queue vip-outbox-queue-staging, and DLQ vip-outbox-dlq-staging) have not been externally verified.',
    });
  }

  const resourceIssueCodes = new Set<DeploymentGuardIssueCode>([
    'PLACEHOLDER_D1_DATABASE_ID',
    'INVALID_D1_DATABASE_ID',
    'STAGING_PRODUCTION_RESOURCE_COLLISION',
    'STAGING_TOP_LEVEL_ENV_MISMATCH',
    'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
  ]);
  const resourceIssues = issues.filter((i) => resourceIssueCodes.has(i.code));
  const stagingResourceReady = localConfigValid && resourceIssues.length === 0;

  // 10. External Cloudflare Secret Verification (never defaults to true on empty object)
  const extSecrets = options.externalVerification?.secrets;
  const verifiedSecretSet = new Set<string>(
    Array.isArray(extSecrets?.verifiedEncryptedSecretKeys)
      ? extSecrets.verifiedEncryptedSecretKeys
      : []
  );
  const allRequiredSecretsExternallyVerified =
    extSecrets !== undefined &&
    extSecrets.historicalPlaintextSecretsCleared === true &&
    REQUIRED_SECRET_KEYS.every((k) => verifiedSecretSet.has(k));

  if (!allRequiredSecretsExternallyVerified) {
    issues.push({
      code: 'UNVERIFIED_EXTERNAL_SECRETS',
      scope: 'cloudflare-secrets',
      message: `[cloudflare-secrets] Required encrypted Cloudflare Secrets (${REQUIRED_SECRET_KEYS.join(', ')}) and removal of historical plaintext secret bindings have not been externally verified.`,
    });
  }

  const secretIssueCodes = new Set<DeploymentGuardIssueCode>([
    'SECRET_IN_PLAINTEXT_VARS',
    'HISTORICAL_PLAINTEXT_SECRET_BINDING',
    'MISSING_SECRET_DECLARATION',
    'NON_EMPTY_SECRET_IN_ENV_EXAMPLE',
    'UNVERIFIED_EXTERNAL_SECRETS',
  ]);
  const secretIssues = issues.filter((i) => secretIssueCodes.has(i.code));
  const secretConfigReady = secretIssues.length === 0;

  // 11. External Admin Notification Route Verification (never defaults to true on empty object)
  const extAdmin = options.externalVerification?.adminNotification;
  const hasValidConfiguredGroup =
    extAdmin?.configuredAdminGroupId === undefined ||
    (!isPlaceholderVarValue(extAdmin.configuredAdminGroupId) &&
      extAdmin.configuredAdminGroupId.trim() !== 'UNCONFIGURED_ADMIN_GROUP_CHAT' &&
      /^-\d{5,20}$/.test(extAdmin.configuredAdminGroupId.trim()));
  const hasValidConfiguredSuperAdminIds =
    extAdmin?.configuredSuperAdminIds === undefined ||
    (!isPlaceholderVarValue(extAdmin.configuredSuperAdminIds) &&
      extAdmin.configuredSuperAdminIds
        .split(',')
        .some((id) => /^\d{1,20}$/.test(id.trim())));

  const adminNotificationReady =
    extAdmin !== undefined &&
    extAdmin.dashboardVarsConfigured === true &&
    extAdmin.activeStartedSuperAdminVerified === true &&
    (extAdmin.adminGroupVerified === true || extAdmin.activeStartedSuperAdminVerified === true) &&
    hasValidConfiguredGroup &&
    hasValidConfiguredSuperAdminIds;

  if (!adminNotificationReady) {
    issues.push({
      code: 'UNVERIFIED_ADMIN_NOTIFICATION_ROUTE',
      scope: 'telegram-admin-routing',
      message:
        '[telegram-admin-routing] Admin notification routing is not externally verified. At least one active SUPER_ADMIN must have run /start in private bot chat and Dashboard routing variables (TELEGRAM_BOT_USERNAME, TELEGRAM_ADMIN_GROUP_ID, SUPER_ADMIN_IDS) must be verified before enabling customer-facing traffic.',
    });
  }

  // 12. Live Worker Replacement Risk Check (Architecture B targeting existing live "auto-reply-bot" service)
  const liveWorkerReplacementRisk =
    phaseMode === 'temporary_staging' &&
    resolvedWorkerName === EXPECTED_ARCHITECTURE_B_WORKER_NAME;

  if (liveWorkerReplacementRisk && options.acknowledgeLiveWorkerReplacementRisk !== true) {
    issues.push({
      code: 'LIVE_WORKER_REPLACEMENT_RISK_UNACKNOWLEDGED',
      scope: activeScopeName,
      message: `[${activeScopeName}] BLOCKER: Target Worker "${EXPECTED_ARCHITECTURE_B_WORKER_NAME}" is an existing live Cloudflare Worker receiving 100% traffic. Deploying Architecture B to "${EXPECTED_ARCHITECTURE_B_WORKER_NAME}" will replace the currently running Worker with staging configuration. Owner must explicitly authorize temporary replacement (acknowledgeLiveWorkerReplacementRisk: true) or authorize a separate staging Worker identity.`,
    });
  }

  const deploymentAuthorized =
    options.explicitOwnerAuthorization === true &&
    (!liveWorkerReplacementRisk || options.acknowledgeLiveWorkerReplacementRisk === true) &&
    localConfigValid &&
    stagingResourceReady &&
    secretConfigReady &&
    adminNotificationReady;

  if (options.requireExplicitAuthorization === true && !deploymentAuthorized) {
    issues.push({
      code: 'DEPLOYMENT_NOT_AUTHORIZED',
      scope: activeScopeName,
      message:
        'Deployment execution is not authorized. A local repository check never authorizes deployment; verified external resources, verified secrets, verified admin notification routing, live-worker replacement acknowledgment, and explicit Owner authorization are required.',
    });
  }

  const readyToDeploy =
    localConfigValid &&
    stagingResourceReady &&
    secretConfigReady &&
    adminNotificationReady &&
    (!liveWorkerReplacementRisk || options.acknowledgeLiveWorkerReplacementRisk === true) &&
    (options.requireExplicitAuthorization ? deploymentAuthorized : true);

  const sanitizedIssues: DeploymentGuardIssue[] = issues.map((issue) => {
    const redacted = redactLogObject(issue) as Record<string, unknown>;
    return {
      code: issue.code,
      scope: String(redacted.scope ?? issue.scope),
      message: String(redacted.message ?? issue.message),
    };
  });

  return {
    localConfigValid,
    stagingResourceReady,
    secretConfigReady,
    adminNotificationReady,
    deploymentAuthorized,
    readyToDeploy,
    liveWorkerReplacementRisk,
    advisoryScope: 'LOCAL_REPOSITORY_CHECK_ONLY_NOT_REMOTE_CI_OR_IAM_LOCK',
    resolvedWorkerName,
    targetEnv,
    phaseMode,
    issues: sanitizedIssues,
  };
}

/**
 * Explicit pre-deployment gate that requires all 5 states:
 * 1. localConfigValid
 * 2. stagingResourceReady
 * 3. secretConfigReady
 * 4. adminNotificationReady
 * 5. deploymentAuthorized (explicitOwnerAuthorization: true + acknowledgeLiveWorkerReplacementRisk: true when targeting auto-reply-bot)
 *
 * NOTE: This function is a local repository verification gate only and does NOT control Cloudflare IAM or external Cloudflare Workers Builds pipelines.
 */
export function enforceDeploymentGate(
  rawConfig: unknown,
  options: DeploymentGuardOptions = {}
): DeploymentGuardResult {
  const result = validateWranglerDeploymentConfig(rawConfig, {
    ...options,
    requireExplicitAuthorization: true,
  });

  if (!result.readyToDeploy || !result.deploymentAuthorized) {
    const codes = result.issues.map((i) => i.code).join(', ');
    throw new Error(`DEPLOYMENT_GATE_BLOCKED: [${codes}]`);
  }

  return result;
}
