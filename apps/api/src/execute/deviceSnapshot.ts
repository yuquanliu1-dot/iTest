import type { AccessibilityNode, AccessibilitySnapshot } from './agentDeviceClient.js';
import type { Locator } from '@itest/shared';

export function snapshotToLocators(node: AccessibilityNode): Locator[] {
  const out: Locator[] = [];
  if (node.accessibilityId) out.push({ strategy: 'accessibilityId', value: node.accessibilityId });
  if (node.label) out.push({ strategy: 'label', value: node.label });
  if (node.role && node.bounds) {
    const cx = node.bounds.x + node.bounds.width / 2;
    const cy = node.bounds.y + node.bounds.height / 2;
    out.push({ strategy: 'predicate', value: `role==${node.role} && bounds.center==(${cx},${cy})` });
  }
  return out;
}

export function findBounds(
  snapshot: AccessibilitySnapshot,
  predicate: (n: AccessibilityNode) => boolean,
): { x: number; y: number; width: number; height: number } | null {
  for (const n of snapshot.nodes) {
    if (predicate(n) && n.bounds) return n.bounds;
  }
  return null;
}

export function matchLocator(l: Locator, n: AccessibilityNode): boolean {
  if (l.strategy === 'accessibilityId') return n.accessibilityId === l.value;
  if (l.strategy === 'label') return n.label === l.value;
  return false;
}
