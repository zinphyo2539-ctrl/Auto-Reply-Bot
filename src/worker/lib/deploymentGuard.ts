import { redactLogObject } from './logger';

export const EXPECTED_ROOT_WORKER_NAME = 'auto-reply-bot';
export const EXPECTED_ARCHITECTURE_B_WORKER_NAME = EXPECTED_ROOT_WORKER_NAME;
export const EXPECTED_STAGING_WORKER_NAME = 'auto-reply-bot-staging';
export const EXPECTED_PRODUCTION_WORKER_NAME = 'auto-reply-bot-production';

export const CONFIRMED_STAGING_D1_DATABASE_NAME = 'vip-gaming-d1-staging';
export const CONFIRMED_STAGING_D1_DATABASE_ID = 'bf4ea8f0-9212-4028-bc3b-00f274d44413';
export const CONFIRMED_STAGING_PRIMARY_QUEUE = 'vip-outbox-queue-staging';
export const CONFIRMED_STAGING_DLQ = 'vip-outbox-dlq-staging';

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

export interface WranglerBuildConfig {
  command?: string;
  cwd?: string;
  watch_dir?: string | string[];
}

export interface WranglerEnvironmentScopeConfig {
  name?: string;
  keep_vars?: boolean;
  build?: WranglerBuildConfig;
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
  | 'MISSING_EXPLICIT_TARGET_ENV'
  | 'INCONSISTENT_WORKER_IDENTITY'
  | 'ROOT_STAGING_WORKER_IDENTITY_COLLISION'
  | 'ROOT_DEPLOYMENT_FORBIDDEN'
  | 'ROOT_RESOURCE_BINDINGS_FORBIDDEN'
  | 'MISSING_PREDEPLOY_BUILD_COMMAND_HOOK'
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
  | 'STAGING_RESOURCE_IDENTITY_MISMATCH'
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
  localConfigValid: boolean;
  stagingResourceReady: boolean;
  secretConfigReady: boolean;
  adminNotificationReady: boolean;
  deploymentAuthorized: boolean;
  readyToDeploy: boolean;
  liveWorkerReplacementRisk: boolean;
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
    issues.push({
      code: 'MISSING_STATIC_VAR',
      scope: scopeName,
      message: `[${scopeName}] Expected vars.ENVIRONMENT to be "${expectedEnvironmentValue}" (found "${String(vars.ENVIRONMENT ?? '')}").`,
    });
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
      } else if (scopeName === 'env.staging') {
        if (
          dbBinding.database_name !== CONFIRMED_STAGING_D1_DATABASE_NAME ||
          dbBinding.database_id?.trim().toLowerCase() !== CONFIRMED_STAGING_D1_DATABASE_ID
        ) {
          issues.push({
            code: 'STAGING_RESOURCE_IDENTITY_MISMATCH',
            scope: scopeName,
            message: `[${scopeName}] Staging D1 binding "DB" must use database_name "${CONFIRMED_STAGING_D1_DATABASE_NAME}" and confirmed UUID "${CONFIRMED_STAGING_D1_DATABASE_ID}" (found "${dbBinding.database_name ?? ''}" / "${dbBinding.database_id ?? ''}").`,
          });
        }
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

  if (scopeName === 'env.staging' && outboxProducer.queue !== CONFIRMED_STAGING_PRIMARY_QUEUE) {
    issues.push({
      code: 'STAGING_RESOURCE_IDENTITY_MISMATCH',
      scope: scopeName,
      message: `[${scopeName}] Staging Queue producer "OUTBOX_QUEUE" must target "${CONFIRMED_STAGING_PRIMARY_QUEUE}" (found "${outboxProducer.queue}").`,
    });
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
  if (scopeName === 'env.staging' && dlqName !== CONFIRMED_STAGING_DLQ) {
    issues.push({
      code: 'STAGING_RESOURCE_IDENTITY_MISMATCH',
      scope: scopeName,
      message: `[${scopeName}] Staging primary Queue consumer must configure dead_letter_queue "${CONFIRMED_STAGING_DLQ}" (found "${dlqName}").`,
    });
  }

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

function validatePredeployBuildCommandHooks(
  cfg: WranglerRootConfig,
  issues: DeploymentGuardIssue[]
): void {
  const expectedHooks: ReadonlyArray<{
    scopeName: string;
    build: WranglerBuildConfig | undefined;
    requiredFlag: string;
  }> = [
    {
      scopeName: 'top-level',
      build: cfg.build,
      requiredFlag: '--target=top-level',
    },
    {
      scopeName: 'env.staging',
      build: cfg.env?.staging?.build,
      requiredFlag: '--target=staging',
    },
    {
      scopeName: 'env.production',
      build: cfg.env?.production?.build,
      requiredFlag: '--target=production',
    },
  ];

  for (const hook of expectedHooks) {
    const cmd = typeof hook.build?.command === 'string' ? hook.build.command.trim() : '';
    if (!cmd || !cmd.includes('scripts/predeploy-check.ts') || !cmd.includes(hook.requiredFlag)) {
      issues.push({
        code: 'MISSING_PREDEPLOY_BUILD_COMMAND_HOOK',
        scope: hook.scopeName,
        message: `[${hook.scopeName}] Missing or invalid Wrangler "build.command" pre-deploy guard hook (must execute "scripts/predeploy-check.ts ${hook.requiredFlag}").`,
      });
    }
  }
}

function validateRootZeroBindingsAndCrossEnvironmentIsolation(
  cfg: WranglerRootConfig,
  issues: DeploymentGuardIssue[]
): void {
  // 1. Root scope must contain NO D1 bindings, NO Queue bindings, NO runtime vars, and NO Cron triggers
  const hasRootD1 = Array.isArray(cfg.d1_databases) && cfg.d1_databases.length > 0;
  const hasRootQueueProducers =
    Array.isArray(cfg.queues?.producers) && cfg.queues!.producers!.length > 0;
  const hasRootQueueConsumers =
    Array.isArray(cfg.queues?.consumers) && cfg.queues!.consumers!.length > 0;
  const hasRootVars =
    cfg.vars !== undefined &&
    typeof cfg.vars === 'object' &&
    Object.keys(cfg.vars).length > 0;
  const hasRootCrons =
    Array.isArray(cfg.triggers?.crons) && cfg.triggers!.crons!.length > 0;

  if (
    hasRootD1 ||
    hasRootQueueProducers ||
    hasRootQueueConsumers ||
    hasRootVars ||
    hasRootCrons
  ) {
    issues.push({
      code: 'ROOT_RESOURCE_BINDINGS_FORBIDDEN',
      scope: 'top-level',
      message:
        '[top-level] Root Wrangler scope must contain zero D1 bindings, Queue bindings, runtime vars, or Cron triggers under Phase 6.3 isolation so the existing "auto-reply-bot" Worker is never targeted or collided with.',
    });
  }

  // If root vars were erroneously added, also inspect them for secret/dashboard leaks
  if (hasRootVars) {
    validateVarsBlock('top-level', cfg.vars, 'staging', issues);
  }

  const stgEnv = cfg.env?.staging;
  const prodEnv = cfg.env?.production;

  const stgD1 = stgEnv?.d1_databases?.find((d) => d.binding === 'DB');
  const stgProducer = stgEnv?.queues?.producers?.find((p) => p.binding === 'OUTBOX_QUEUE');
  const stgConsumers = stgEnv?.queues?.consumers ?? [];
  const stgQueueNames = new Set<string>(
    [
      stgProducer?.queue,
      ...stgConsumers.map((c) => c.queue),
      ...stgConsumers.map((c) => c.dead_letter_queue),
    ].filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
  );

  // 2. Check collisions between env.staging and env.production
  if (stgEnv && prodEnv) {
    const prodD1 = prodEnv.d1_databases?.find((d) => d.binding === 'DB');
    const prodProducer = prodEnv.queues?.producers?.find((p) => p.binding === 'OUTBOX_QUEUE');
    const prodConsumers = prodEnv.queues?.consumers ?? [];
    const prodQueueNames = new Set<string>(
      [
        prodProducer?.queue,
        ...prodConsumers.map((c) => c.queue),
        ...prodConsumers.map((c) => c.dead_letter_queue),
      ].filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    );

    if (stgD1 && prodD1) {
      if (stgD1.database_name && stgD1.database_name === prodD1.database_name) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'env.production',
          message: `Staging and Production D1 bindings share the same database_name "${stgD1.database_name}". Staging and Production databases must be strictly isolated.`,
        });
      }
      if (
        stgD1.database_id &&
        prodD1.database_id &&
        !isPlaceholderD1DatabaseId(stgD1.database_id) &&
        !isPlaceholderD1DatabaseId(prodD1.database_id) &&
        stgD1.database_id.trim().toLowerCase() === prodD1.database_id.trim().toLowerCase()
      ) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'env.production',
          message: `Staging and Production D1 bindings share the same database_id "${stgD1.database_id}". Staging and Production databases must be strictly isolated.`,
        });
      }
    }

    for (const qName of stgQueueNames) {
      if (prodQueueNames.has(qName)) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'env.production',
          message: `Staging and Production Queue configurations share queue "${qName}". Queue producers, consumers, and DLQs must be strictly disjoint.`,
        });
      }
    }
  }

  // 3. Also detect if root erroneously references any staging or production D1/Queue resource
  if (hasRootD1) {
    for (const rootD1 of cfg.d1_databases ?? []) {
      if (
        stgD1 &&
        ((rootD1.database_name && rootD1.database_name === stgD1.database_name) ||
          (rootD1.database_id &&
            !isPlaceholderD1DatabaseId(rootD1.database_id) &&
            rootD1.database_id.trim().toLowerCase() === stgD1.database_id?.trim().toLowerCase()))
      ) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `[top-level] Root D1 binding collides with staging D1 resource "${stgD1.database_name}" (${stgD1.database_id}).`,
        });
      }
    }
  }

  if (hasRootQueueProducers || hasRootQueueConsumers) {
    const rootQueueNames = new Set<string>(
      [
        ...(cfg.queues?.producers ?? []).map((p) => p.queue),
        ...(cfg.queues?.consumers ?? []).map((c) => c.queue),
        ...(cfg.queues?.consumers ?? []).map((c) => c.dead_letter_queue),
      ].filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
    );
    for (const qName of rootQueueNames) {
      if (stgQueueNames.has(qName)) {
        issues.push({
          code: 'STAGING_PRODUCTION_RESOURCE_COLLISION',
          scope: 'top-level',
          message: `[top-level] Root Queue configuration collides with staging queue "${qName}".`,
        });
      }
    }
  }
}

export function validateWranglerDeploymentConfig(
  rawConfig: unknown,
  options: DeploymentGuardOptions = {}
): DeploymentGuardResult {
  const rawTargetEnv =
    typeof options.targetEnv === 'string' ? options.targetEnv.trim() : '';
  const targetEnv = rawTargetEnv || 'unspecified';
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

  if (!rawTargetEnv) {
    issues.push({
      code: 'MISSING_EXPLICIT_TARGET_ENV',
      scope: 'options.targetEnv',
      message:
        'Explicit targetEnv ("staging" | "production" | "top-level") is required. Missing targetEnv fails closed.',
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

  const cfg = rawConfig as WranglerRootConfig;
  const baseName = typeof cfg.name === 'string' && cfg.name.trim() ? cfg.name.trim() : null;

  // 0. Root Worker identity preservation check ("auto-reply-bot")
  if (baseName !== EXPECTED_ROOT_WORKER_NAME) {
    issues.push({
      code: 'INCONSISTENT_WORKER_IDENTITY',
      scope: 'top-level',
      message: `Top-level Worker name must remain "${EXPECTED_ROOT_WORKER_NAME}" so "--env staging" derives "${EXPECTED_STAGING_WORKER_NAME}" and existing Worker identity is preserved (found "${String(cfg.name ?? '')}").`,
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

  // 3. Validate pre-deploy build.command hooks and zero-root-binding isolation
  validatePredeployBuildCommandHooks(cfg, issues);
  validateRootZeroBindingsAndCrossEnvironmentIsolation(cfg, issues);

  // 4. Validate vars blocks on env.staging and env.production
  if (cfg.env?.staging) {
    validateVarsBlock('env.staging', cfg.env.staging.vars, 'staging', issues);
  } else {
    issues.push({
      code: 'INVALID_TARGET_ENVIRONMENT',
      scope: 'env.staging',
      message: 'Named environment "env.staging" must be defined in wrangler.jsonc.',
    });
  }

  if (cfg.env?.production) {
    validateVarsBlock('env.production', cfg.env.production.vars, 'production', issues);
  } else {
    issues.push({
      code: 'INVALID_TARGET_ENVIRONMENT',
      scope: 'env.production',
      message: 'Named environment "env.production" must be defined in wrangler.jsonc.',
    });
  }

  // 5. Target environment selection & phase mode guard
  const allowedTargets = new Set(['top-level', 'staging', 'production']);
  if (!allowedTargets.has(targetEnv)) {
    issues.push({
      code: 'INVALID_TARGET_ENVIRONMENT',
      scope: targetEnv,
      message: `Invalid target environment "${targetEnv}". Allowed targets: staging, production, top-level.`,
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

  if (targetEnv === 'top-level') {
    issues.push({
      code: 'ROOT_DEPLOYMENT_FORBIDDEN',
      scope: 'top-level',
      message:
        '[top-level] Direct root deployment targeting "auto-reply-bot" is strictly forbidden under Phase 6.3 isolation to protect the existing Worker v7. Deploy exclusively to "--env staging" ("auto-reply-bot-staging").',
    });
  }

  if (targetEnv === 'production' && phaseMode === 'temporary_staging') {
    issues.push({
      code: 'PRODUCTION_BLOCKED_IN_TEMPORARY_STAGING_PHASE',
      scope: 'env.production',
      message:
        'Production deployment blocked: repository is locked in staging-only mode ("auto-reply-bot-staging") and production activation is not authorized.',
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

  if (targetEnv === 'staging' && resolvedWorkerName !== EXPECTED_STAGING_WORKER_NAME) {
    issues.push({
      code: 'INCONSISTENT_WORKER_IDENTITY',
      scope: 'env.staging',
      message: `[env.staging] Staging Worker identity must resolve to "${EXPECTED_STAGING_WORKER_NAME}" (found "${String(resolvedWorkerName ?? '')}").`,
    });
  }

  // 6. WRANGLER_CI_OVERRIDE_NAME interaction check
  // In Wrangler 4.168.0, a mismatched WRANGLER_CI_OVERRIDE_NAME logs a warning and silently overrides the target Worker name.
  if (options.ciOverrideName !== undefined && options.ciOverrideName.trim().length > 0) {
    const override = options.ciOverrideName.trim();
    const expectedForTarget =
      targetEnv === 'staging'
        ? EXPECTED_STAGING_WORKER_NAME
        : targetEnv === 'production'
          ? EXPECTED_PRODUCTION_WORKER_NAME
          : EXPECTED_ROOT_WORKER_NAME;

    if (override !== expectedForTarget) {
      issues.push({
        code: 'CI_OVERRIDE_NAME_MISMATCH',
        scope: activeScopeName,
        message: `WRANGLER_CI_OVERRIDE_NAME="${override}" mismatches expected target Worker "${expectedForTarget}" for "${activeScopeName}". Blocked before Wrangler 4.168.0 can silently override the Worker name to "${override}".`,
      });
    } else {
      resolvedWorkerName = override;
    }
  }

  // 7. Validate bindings on the selected target scope (and always validate env.staging bindings)
  if (targetEnv === 'top-level') {
    if (cfg.env?.staging) {
      validateScopeBindings('env.staging', cfg.env.staging, issues);
    }
  } else {
    validateScopeBindings(activeScopeName, activeScope, issues);
  }

  // 8. Optional .env.example secret declaration check (verifies names & empty values only, never real secrets)
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

  // 9. Check for historical plaintext credential bindings on the Dashboard (which keep_vars: true would preserve)
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

  // 10. External Cloudflare Staging Resource Verification (never defaults to true on empty object)
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
    'STAGING_RESOURCE_IDENTITY_MISMATCH',
    'STAGING_PRODUCTION_RESOURCE_COLLISION',
    'STAGING_TOP_LEVEL_ENV_MISMATCH',
    'ROOT_RESOURCE_BINDINGS_FORBIDDEN',
    'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
  ]);
  const resourceIssues = issues.filter((i) => resourceIssueCodes.has(i.code));
  const stagingResourceReady = localConfigValid && resourceIssues.length === 0;

  // 11. External Cloudflare Secret Verification (never defaults to true on empty object)
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

  // 12. External Admin Notification Route Verification (never defaults to true on empty object)
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

  // 13. Live Worker Replacement Risk Check
  // True only if the deployment would target or override to the existing live "auto-reply-bot" Worker
  const effectiveCiOverride =
    typeof options.ciOverrideName === 'string' && options.ciOverrideName.trim().length > 0
      ? options.ciOverrideName.trim()
      : null;
  const liveWorkerReplacementRisk =
    targetEnv === 'top-level' ||
    resolvedWorkerName === EXPECTED_ROOT_WORKER_NAME ||
    effectiveCiOverride === EXPECTED_ROOT_WORKER_NAME;

  if (liveWorkerReplacementRisk && options.acknowledgeLiveWorkerReplacementRisk !== true) {
    issues.push({
      code: 'LIVE_WORKER_REPLACEMENT_RISK_UNACKNOWLEDGED',
      scope: activeScopeName,
      message: `[${activeScopeName}] BLOCKER: Target Worker "${EXPECTED_ROOT_WORKER_NAME}" is an existing live Cloudflare Worker (v7). Overwriting "${EXPECTED_ROOT_WORKER_NAME}" is blocked under Phase 6.3 isolation.`,
    });
  }

  const deploymentAuthorized =
    options.explicitOwnerAuthorization === true &&
    !liveWorkerReplacementRisk &&
    localConfigValid &&
    stagingResourceReady &&
    secretConfigReady &&
    adminNotificationReady;

  if (options.requireExplicitAuthorization === true && !deploymentAuthorized) {
    issues.push({
      code: 'DEPLOYMENT_NOT_AUTHORIZED',
      scope: activeScopeName,
      message:
        'Deployment execution is not authorized. A local repository check never authorizes deployment; verified external resources, verified secrets, verified admin notification routing, zero live-worker replacement risk, and explicit Owner authorization are required.',
    });
  }

  const readyToDeploy =
    localConfigValid &&
    stagingResourceReady &&
    secretConfigReady &&
    adminNotificationReady &&
    !liveWorkerReplacementRisk &&
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
