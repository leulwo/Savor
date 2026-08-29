/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

export interface AuditActor {
  email: string;
  role: string;
}

export interface AuditPayload {
  action: string;
  category: 'order' | 'menu' | 'settings' | 'team' | 'customer' | 'general';
  targetId?: string;
  details?: Record<string, any>;
}

export async function logAudit(
  actor: AuditActor,
  payload: AuditPayload
): Promise<void> {
  try {
    const entry = {
      actorEmail: actor.email || 'system',
      actorRole: actor.role || 'unknown',
      action: payload.action,
      category: payload.category,
      targetId: payload.targetId || null,
      details: payload.details || {},
      createdAt: serverTimestamp(),
    };

    await addDoc(collection(db, "audit_log"), entry);
  } catch (error) {
    console.warn("[AuditLog] Failed to record audit log entry:", error);
  }
}
