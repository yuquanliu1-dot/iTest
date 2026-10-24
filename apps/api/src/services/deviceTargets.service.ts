import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceTargets, testCases } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';

export interface DeviceTargetSaveBody {
  name: string;
  mobileOs: 'ios' | 'android';
  deviceRef: string;
  appBundleId?: string | null;
  appPath?: string | null;
  launchArgs?: string[];
}

export async function listDeviceTargets(projectId: string) {
  return db.select().from(deviceTargets).where(eq(deviceTargets.projectId, projectId)).orderBy(asc(deviceTargets.createdAt));
}

export async function getDeviceTarget(id: string) {
  const rows = await db.select().from(deviceTargets).where(eq(deviceTargets.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function resolveDeviceTarget(id: string) {
  return getDeviceTarget(id);
}

export async function createDeviceTarget(projectId: string, body: DeviceTargetSaveBody) {
  try {
    const rows = await db.insert(deviceTargets).values({
      projectId,
      name: body.name.trim(),
      mobileOs: body.mobileOs,
      deviceRef: body.deviceRef.trim(),
      appBundleId: body.appBundleId ?? null,
      appPath: body.appPath ?? null,
      launchArgs: body.launchArgs ?? [],
    }).returning();
    return rows[0]!;
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      throw new HttpError(409, 'name_conflict', 'device target name already exists in this project');
    }
    throw e;
  }
}

export async function updateDeviceTarget(id: string, body: DeviceTargetSaveBody) {
  const existing = await getDeviceTarget(id);
  if (!existing) throw new HttpError(404, 'not_found', 'device target not found');
  try {
    const rows = await db.update(deviceTargets).set({
      name: body.name.trim(),
      mobileOs: body.mobileOs,
      deviceRef: body.deviceRef.trim(),
      appBundleId: body.appBundleId ?? null,
      appPath: body.appPath ?? null,
      launchArgs: body.launchArgs ?? [],
      updatedAt: new Date(),
    }).where(eq(deviceTargets.id, id)).returning();
    return rows[0]!;
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      throw new HttpError(409, 'name_conflict', 'device target name already exists in this project');
    }
    throw e;
  }
}

export async function deleteDeviceTarget(id: string) {
  const deleted = await db.delete(deviceTargets).where(eq(deviceTargets.id, id)).returning({ id: deviceTargets.id });
  if (deleted.length === 0) throw new HttpError(404, 'not_found', 'device target not found');
}

/** 删除前引用计数(绑定该设备目标的移动用例数;删除后 FK set null 自动解绑,计数仅进确认卡提示)。 */
export async function deviceTargetUsage(id: string): Promise<{ caseCount: number }> {
  const rows = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.mobileDeviceTargetId, id));
  return { caseCount: rows.length };
}