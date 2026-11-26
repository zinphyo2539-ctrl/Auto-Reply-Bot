import type { Env } from '../types/bindings';
import type { AdminRow } from '../types/domain';
import { executeAtomicBatch } from '../repositories/d1BatchCoordinator';
import { adminRepository } from '../repositories/adminRepository';
import { ticketRepository } from '../repositories/ticketRepository';
import { configRepository } from '../repositories/configRepository';
import { auditRepository } from '../repositories/auditRepository';
import { generateMutationToken } from '../lib/ids';
import { systemClock } from '../lib/clock';
import { AuthorizationError, ConflictError } from '../lib/errors';

export const adminService = {
  async ensureBootstrapSuperAdmins(env: Env, nowMs = systemClock.now()): Promise<void> {
    if (!env.SUPER_ADMIN_IDS) return;
    const ids = env.SUPER_ADMIN_IDS.split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{1,20}$/.test(s));

    for (const id of ids) {
      const existing = await adminRepository.getById(env.DB, id);
      if (!existing) {
        await adminRepository.upsertBootstrapSuperAdmin(
          env.DB,
          id,
          `Super Admin ${id}`,
          generateMutationToken(nowMs),
          nowMs
        );
      }
    }
  },

  async toggleGlobalAi(
    env: Env,
    params: {
      adminId: string;
      correlationId: string;
      sourceUpdateId?: number | null;
      nowMs?: number;
    }
  ): Promise<{ aiEnabled: boolean; newVersion: number }> {
    const nowMs = params.nowMs ?? systemClock.now();
    const admin = await adminRepository.getActiveAdmin(env.DB, params.adminId);
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      await auditRepository.appendImmediate(env.DB, {
        actorId: params.adminId,
        actorRole: admin?.role ?? 'UNAUTHORIZED',
        action: 'UNAUTHORIZED_CONFIG_TOGGLE_AI_ATTEMPT',
        resourceType: 'CONFIG',
        resourceId: 'active',
        result: 'DENIED',
        reason: 'Only SUPER_ADMIN may toggle global AI',
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      });
      throw new AuthorizationError('Only SUPER_ADMIN is authorized to toggle global AI settings');
    }

    const config = await configRepository.getActiveConfig(env.DB);
    const nextEnabled = config.ai_enabled !== 1;
    const mutationToken = generateMutationToken(nowMs);

    const auditStmt = await auditRepository.buildInsertStatement(
      env.DB,
      {
        actorId: params.adminId,
        actorRole: 'SUPER_ADMIN',
        action: 'CONFIG_AI_ENABLED_TOGGLED',
        resourceType: 'CONFIG',
        resourceId: 'active',
        result: 'SUCCESS',
        beforeState: { aiEnabled: config.ai_enabled === 1, activeVersion: config.active_version },
        afterState: { aiEnabled: nextEnabled, activeVersion: config.active_version + 1 },
        correlationId: params.correlationId,
        sourceUpdateId: params.sourceUpdateId ?? null,
        nowMs,
      },
      {
        table: 'config',
        pkColumn: 'config_id',
        pkValue: 'active',
        mutationToken,
      }
    );

    const results = await executeAtomicBatch(env.DB, [
      configRepository.prepareToggleAi(env.DB, {
        aiEnabled: nextEnabled,
        actorAdminId: params.adminId,
        expectedVersion: config.active_version,
        mutationToken,
        nowMs,
      }),
      configRepository.prepareSnapshotConfigVersion(env.DB, mutationToken, null),
      auditStmt,
    ]);

    if ((results[0]?.results?.length ?? 0) === 0) {
      throw new ConflictError('Config was modified concurrently');
    }

    return { aiEnabled: nextEnabled, newVersion: config.active_version + 1 };
  },

  async buildAdminStatusText(env: Env, admin: AdminRow): Promise<string> {
    const [config, openTickets] = await Promise.all([
      configRepository.getActiveConfig(env.DB),
      ticketRepository.listOpenTickets(env.DB, 10),
    ]);

    const lines = [
      `🛡 <b>7777club Admin Console</b>`,
      `• Admin ID: <code>${admin.telegram_user_id}</code> (<b>${admin.role}</b>)`,
      `• AI Auto-Reply: <b>${config.ai_enabled === 1 ? 'ENABLED 🟢' : 'DISABLED 🔴'}</b> (v${config.active_version})`,
      `• Open Queue Tickets: <b>${openTickets.length}</b>`,
      '',
      '<b>Telegram Admin Commands:</b>',
      '• <code>/admin</code> — View dashboard & open queue',
      '• <code>/reply &lt;TICKET_ID&gt; &lt;text&gt;</code> — Reply to customer',
      '• <code>/approve_dep &lt;DEP_ID&gt; &lt;ver&gt; &lt;EVIDENCE_REF&gt;</code> — (SUPER_ADMIN)',
      '• <code>/reject_dep &lt;DEP_ID&gt; &lt;ver&gt; &lt;REASON&gt;</code> — (SUPER_ADMIN)',
      '• <code>/paid_wd &lt;WDR_ID&gt; &lt;ver&gt; &lt;PAYMENT_EVIDENCE&gt;</code> — (SUPER_ADMIN)',
      '• <code>/reject_wd &lt;WDR_ID&gt; &lt;ver&gt; &lt;REASON&gt;</code> — (SUPER_ADMIN)',
      '• <code>/view_wd_pii &lt;WDR_ID&gt;</code> — (SUPER_ADMIN Private Chat Only)',
      '• <code>/toggle_ai</code> — (SUPER_ADMIN)',
    ];

    return lines.join('\n');
  },
};
