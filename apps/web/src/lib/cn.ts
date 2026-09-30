import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 Tailwind class，处理冲突（后者覆盖前者）+ 条件 class。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
