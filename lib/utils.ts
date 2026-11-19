/**
 * [INPUT]: 依赖 clsx / tailwind-merge
 * [OUTPUT]: 对外提供 cn（类名合并）、formatHomePathForDisplay（家目录缩写成 ~）
 * [POS]: lib 的通用小工具; 消费者: components/lineage-list.tsx
 * [PROTOCOL]: 变更时更新此头部,然后检查所在目录 CLAUDE.md
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatHomePathForDisplay(pathValue: string): string {
  const homePrefix =
    pathValue.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/root(?=\/|$)/)?.[0] ??
    pathValue.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i)?.[0];
  return homePrefix === undefined
    ? pathValue
    : `~${pathValue.slice(homePrefix.length)}`;
}
