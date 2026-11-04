import { prisma } from '../database/prisma.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auditLog = () => (prisma() as any).auditLog;

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'REGENERATE';
// M29: extended for regeneration/maintenance coverage — bulk deletes and
// settings changes previously left no audit trail.
export type EntityType = 'story' | 'episode' | 'scene' | 'user' | 'setting' | 'webhook' | 'bulk';

export interface AuditLogEntry {
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
  userAgent?: string;
  userId?: string;
}

export function buildAuditLogEntry(entry: AuditLogEntry): Record<string, unknown> {
  const data: Record<string, unknown> = {
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
  };
  if (entry.before !== undefined) data.before = entry.before;
  if (entry.after !== undefined) data.after = entry.after;
  if (entry.ipAddress !== undefined) data.ipAddress = entry.ipAddress;
  if (entry.userAgent !== undefined) data.userAgent = entry.userAgent;
  if (entry.userId !== undefined) data.userId = entry.userId;
  return data;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await auditLog().create({
      data: buildAuditLogEntry(entry),
    });
  } catch (err) {
    // Audit logging must never fail the operation.
    // M29: log only identifiers, not the full entry — before/after payloads
    // can contain PII and would echo into error logs.
    const logger = await import('./logger.js').then((m) => m.logger);
    logger.error(
      { err, action: entry.action, entityType: entry.entityType, entityId: entry.entityId },
      'Audit log write failed (non-fatal)'
    );
  }
}
