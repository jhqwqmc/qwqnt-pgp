/**
 * 在线密钥查询：GitHub（按用户名拿 GPG 公钥）。
 * GitHub 的接口匿名可用：GET https://api.github.com/users/<user>/gpg_keys
 */
import type { KeySearchResult } from '@/shared/types';

const GITHUB_API = 'https://api.github.com';

interface GithubGpgKey {
  id: number;
  key_id: string;
  raw_key: string | null;
  emails?: Array<{ email: string; verified: boolean }>;
}

/** 带超时的 fetch（直连；Node 的 fetch 不读环境变量代理） */
async function fetchText(url: string, timeout = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'qwqnt-pgp', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    throw new Error(`GitHub 请求失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 查询某个 GitHub 用户公开的 GPG 公钥 */
export async function searchGithub(username: string): Promise<KeySearchResult[]> {
  const name = username.trim().replace(/^@/, '');
  if (!name) throw new Error('请输入 GitHub 用户名');
  const text = await fetchText(`${GITHUB_API}/users/${encodeURIComponent(name)}/gpg_keys`);
  const list = JSON.parse(text) as GithubGpgKey[];
  if (!Array.isArray(list)) throw new Error('GitHub 返回格式无效');
  return list.map(item => ({
    keyID: item.key_id,
    fingerprint: item.key_id,
    algo: '',
    bits: 0,
    created: 0,
    expires: 0,
    userIds: (item.emails ?? []).map(e => `${e.email}${e.verified ? '（已验证）' : ''}`),
    source: 'github' as const,
    armored: item.raw_key ?? undefined
  }));
}
