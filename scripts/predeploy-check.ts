import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIRMED_STAGING_D1_DATABASE_ID,
  CONFIRMED_STAGING_D1_DATABASE_NAME,
  CONFIRMED_STAGING_DLQ,
  CONFIRMED_STAGING_PRIMARY_QUEUE,
  EXPECTED_STAGING_WORKER_NAME,
  validateWranglerDeploymentConfig,
  type DeploymentGuardIssueCode,
  type DeploymentGuardResult,
} from '../src/worker/lib/deploymentGuard';

export interface PredeployCliExecutionResult {
  allowed: boolean;
  exitCode: 0 | 1;
  targetEnv: string;
  ciOverrideName: string | undefined;
  guardResult: DeploymentGuardResult;
  blockingIssueCodes: DeploymentGuardIssueCode[];
  summaryMessage: string;
}

const EXTERNAL_VERIFICATION_ONLY_CODES = new Set<DeploymentGuardIssueCode>([
  'UNVERIFIED_EXTERNAL_STAGING_RESOURCES',
  'UNVERIFIED_EXTERNAL_SECRETS',
  'UNVERIFIED_ADMIN_NOTIFICATION_ROUTE',
]);

export function parseTargetArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--target=')) {
      return arg.slice('--target='.length).trim();
    }
    if (arg.startsWith('--env=')) {
      return arg.slice('--env='.length).trim();
    }
    if ((arg === '--target' || arg === '--env') && typeof argv[i + 1] === 'string') {
      return argv[i + 1].trim();
    }
  }
  return '';
}

export function stripJsonComments(rawJsonc: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;
  let i = 0;

  while (i < rawJsonc.length) {
    const ch = rawJsonc[i];
    const next = rawJsonc[i + 1];

    if (inString) {
      result += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < rawJsonc.length && rawJsonc[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < rawJsonc.length && !(rawJsonc[i] === '*' && rawJsonc[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

export function runPredeployCheck(options: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configPath?: string;
  envExamplePath?: string;
} = {}): PredeployCliExecutionResult {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? path.resolve(cwd, 'wrangler.jsonc');
  const envExamplePath = options.envExamplePath ?? path.resolve(cwd, '.env.example');

  const targetEnv = parseTargetArg(argv);
  const rawCiOverride = env.WRANGLER_CI_OVERRIDE_NAME;
  const ciOverrideName =
    typeof rawCiOverride === 'string' && rawCiOverride.trim().length > 0
      ? rawCiOverride.trim()
      : undefined;

  let parsedConfig: unknown = null;
  let envExampleContent: string | undefined;

  try {
    const rawWrangler = fs.readFileSync(configPath, 'utf8');
    parsedConfig = JSON.parse(stripJsonComments(rawWrangler));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failedResult = validateWranglerDeploymentConfig(null, {
      targetEnv,
      ciOverrideName,
    });
    return {
      allowed: false,
      exitCode: 1,
      targetEnv: targetEnv || 'unspecified',
      ciOverrideName,
      guardResult: failedResult,
      blockingIssueCodes: ['INVALID_CONFIG_OBJECT'],
      summaryMessage: `[PREDEPLOY_GUARD_BLOCKED] Failed to read or parse wrangler.jsonc: ${msg}`,
    };
  }

  try {
    if (fs.existsSync(envExamplePath)) {
      envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
    }
  } catch {
    envExampleContent = undefined;
  }

  const guardResult = validateWranglerDeploymentConfig(parsedConfig, {
    targetEnv,
    phaseMode: 'temporary_staging',
    ciOverrideName,
    envExampleContent,
  });

  const blockingIssues = guardResult.issues.filter(
    (issue) => !EXTERNAL_VERIFICATION_ONLY_CODES.has(issue.code)
  );
  const blockingIssueCodes = blockingIssues.map((i) => i.code);

  const isApprovedStagingTarget =
    targetEnv === 'staging' &&
    guardResult.localConfigValid === true &&
    guardResult.resolvedWorkerName === EXPECTED_STAGING_WORKER_NAME &&
    guardResult.liveWorkerReplacementRisk === false &&
    blockingIssues.length === 0;

  if (!isApprovedStagingTarget) {
    const details = blockingIssues
      .map((i) => `  - [${i.code}] (${i.scope}): ${i.message}`)
      .join('\n');
    return {
      allowed: false,
      exitCode: 1,
      targetEnv: guardResult.targetEnv,
      ciOverrideName,
      guardResult,
      blockingIssueCodes,
      summaryMessage:
        `[PREDEPLOY_GUARD_BLOCKED] Target "${guardResult.targetEnv}" (resolved Worker: "${String(
          guardResult.resolvedWorkerName ?? 'none'
        )}", WRANGLER_CI_OVERRIDE_NAME: "${String(ciOverrideName ?? '')}") failed Phase 6.3 isolation check:\n` +
        (details || '  - Target environment is not authorized for deployment.'),
    };
  }

  return {
    allowed: true,
    exitCode: 0,
    targetEnv: guardResult.targetEnv,
    ciOverrideName,
    guardResult,
    blockingIssueCodes: [],
    summaryMessage: `[PREDEPLOY_GUARD_PASSED] Verified isolated staging target "${EXPECTED_STAGING_WORKER_NAME}" (D1: ${CONFIRMED_STAGING_D1_DATABASE_NAME} [${CONFIRMED_STAGING_D1_DATABASE_ID}], Queues: ${CONFIRMED_STAGING_PRIMARY_QUEUE} / ${CONFIRMED_STAGING_DLQ}). Existing root Worker "auto-reply-bot" is untouched.`,
  };
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  const res = runPredeployCheck();
  if (!res.allowed) {
    console.error(res.summaryMessage);
    process.exit(res.exitCode);
  }
  console.log(res.summaryMessage);
  process.exit(0);
}
