/**
 * 主进程侧的 GnuPG 封装。
 * 只用 `gpg` 命令行（Windows 下探测常见安装路径），不依赖任何第三方库。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DecryptResult, GpgStatus, KeyInfo, KeySearchResult, SignatureInfo } from '@/shared/types';
import { log } from './log';
import { SerialDecryptQueue } from './decrypt-queue';

const decryptQueue = new SerialDecryptQueue<DecryptResult>(error =>
  /硬件|密钥卡|口令|PIN|pinentry|取消|超时|card|cancel|timed out/i.test(String(error)));

export function resumeDecryption(): void {
  decryptQueue.resume();
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
  timedOut?: boolean;
}

/** 常见 gpg.exe 安装位置（Windows） */
const WINDOWS_GPG_CANDIDATES = [
  'C:\\Program Files\\GnuPG\\bin\\gpg.exe',
  'C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe',
  'C:\\Program Files\\Gpg4win\\bin\\gpg.exe',
  'C:\\Program Files (x86)\\Gpg4win\\bin\\gpg.exe',
];

export class Gpg {
  /** 手动指定的 gpg 路径（空 = 自动探测） */
  private exePath: string;
  private readonly accountScope: string;
  /** 手动指定的 homedir（空 = 系统默认） */
  private home: string;
  /** 探测到的可用路径缓存 */
  private resolved: string | null = null;

  constructor(exePath = '', home = '', accountScope = '') {
    this.exePath = exePath;
    this.home = home;
    this.accountScope = accountScope;
  }

  setPaths(exePath: string, home: string) {
    if (this.exePath !== exePath || this.home !== home) {
      this.exePath = exePath;
      this.home = home;
      this.resolved = null;
    }
  }

  private baseArgs(): string[] {
    const args = ['--batch', '--no-tty'];
    if (this.home) args.push('--homedir', this.home);
    return args;
  }

  /** 执行 gpg（可用 input 写 stdin） */
  private run(args: string[], input?: string, timeout = 120000): Promise<RunResult> {
    return this.resolveExecutable().then(() => new Promise<RunResult>(resolve => {
      const exe = this.exePath || this.resolved || 'gpg';
      const started = Date.now();
      const fullArgs = [...this.baseArgs(), ...args];
      const safeArgs = fullArgs.map((arg, i) => fullArgs[i - 1] === '--passphrase' ? '[redacted]' : arg);
      log(`gpg 执行：${exe} ${safeArgs.join(' ')}${input ? `（stdin ${input.length} 字符）` : ''}`);
      const child = execFile(
        exe,
        fullArgs,
        { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as NodeJS.ErrnoException).code as unknown as number : 1) : 0;
          log(`gpg 完成：code=${code} 耗时 ${Date.now() - started}ms${stdout ? ` stdout=${stdout.length}字符` : ''}${stderr ? ` stderr=${stderr.slice(0, 400).replace(/\s+/g, ' ')}` : ''}`);
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: err ? Number((err as { code?: unknown }).code) || 1 : 0,
            timedOut: !!(err as { killed?: boolean } | null)?.killed,
            error: err ? String((err as Error).message ?? err) : undefined
          });
        }
      );
      child.stdin?.on('error', () => { /* 进程提前退出由 execFile 回调报告 */ });
      child.stdin?.end(input, 'utf8');
    }));
  }

  private async resolveExecutable(): Promise<void> {
    if (this.resolved) return;
    const status = await this.detect();
    if (!status.ok) throw new Error(status.error || '没有找到可用的 gpg');
  }

  /** 探测 gpg：手动路径 > PATH > 常见安装路径 */
  async detect(): Promise<GpgStatus> {
    const tried: string[] = [];
    // 1. 手动指定
    if (this.exePath) {
      tried.push(this.exePath);
      const st = await this.probe(this.exePath);
      this.resolved = st.ok ? this.exePath : null;
      return st;
    }
    // 2. PATH
    {
      const st = await this.probe('gpg');
      if (st.ok) {
        this.resolved = 'gpg';
        return st;
      }
      tried.push('gpg (PATH)');
    }
    // 3. 常见路径
    for (const candidate of WINDOWS_GPG_CANDIDATES) {
      tried.push(candidate);
      if (!existsSync(candidate)) continue;
      const st = await this.probe(candidate);
      if (st.ok) {
        this.resolved = candidate;
        return st;
      }
    }
    return {
      ok: false,
      path: '',
      version: '',
      home: this.home || '(默认)',
      error: `没有找到可用的 gpg。已尝试：\n${tried.join('\n')}`
    };
  }

  /** 用指定可执行文件跑 --version */
  private async probe(exe: string): Promise<GpgStatus> {
    const args = ['--batch', '--no-tty'];
    if (this.home) args.push('--homedir', this.home);
    args.push('--version');
    const res = await new Promise<RunResult>(resolve => {
      execFile(
        exe,
        args,
        { timeout: 15000, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: err ? 1 : 0,
            error: err ? String((err as Error).message ?? err) : undefined
          });
        }
      );
    });
    if (res.code === 0) {
      const first = res.stdout.split(/\r?\n/).find(l => l.trim()) ?? '';
      return {
        ok: true,
        path: exe,
        version: first.trim(),
        home: this.home || '(默认)'
      };
    }
    return {
      ok: false,
      path: exe,
      version: '',
      home: this.home || '(默认)',
      error: (res.stderr || res.error || '').trim()
    };
  }

  /** 确保可用（返回探测结果） */
  async ensure(): Promise<GpgStatus> {
    if (this.resolved) {
      const st = await this.probe(this.resolved);
      st.path = this.resolved;
      if (st.ok) return st;
      this.resolved = null;
    }
    return this.detect();
  }

  /** 列出密钥 */
  async listKeys(): Promise<{ secret: KeyInfo[]; public: KeyInfo[] }> {
    const [pub, sec] = await Promise.all([
      this.run(['--with-colons', '--fixed-list-mode', '--list-keys']),
      this.run(['--with-colons', '--fixed-list-mode', '--list-secret-keys'])
    ]);
    if (pub.code !== 0 || sec.code !== 0) {
      throw new Error(`读取钥匙串失败：${pub.stderr || sec.stderr || pub.error || sec.error}`);
    }
    const publicKeys = parseColonKeys(pub.stdout);
    const secretKeys = parseColonKeys(sec.stdout);
    const secretIds = new Set(secretKeys.map(k => k.fingerprint));
    for (const k of publicKeys) {
      if (secretIds.has(k.fingerprint)) {
        k.secret = true;
        const sk = secretKeys.find(s => s.fingerprint === k.fingerprint);
        if (sk) k.secret = true;
      }
    }
    return { secret: secretKeys, public: publicKeys };
  }

  /** 导出公钥（armored） */
  async exportKey(keyID: string, secret = false): Promise<string> {
    const res = await this.run(['--armor', secret ? '--export-secret-keys' : '--export', keyID]);
    if (res.code !== 0 || !res.stdout.includes('BEGIN PGP')) {
      throw new Error(`导出失败：${(res.stderr || res.error || '').trim()}`);
    }
    return res.stdout;
  }

  /** 导入密钥 */
  async importKey(armored: string): Promise<{ keyIDs: string[] }> {
    const res = await this.run(['--import'], armored);
    if (res.code !== 0) {
      throw new Error(`导入失败：${(res.stderr || res.error || '').trim()}`);
    }
    const ids: string[] = [];
    for (const line of res.stderr.split(/\r?\n/)) {
      const m = /key ([0-9A-F]{16,40})/i.exec(line);
      if (m && m[1]) ids.push(m[1]);
    }
    return { keyIDs: ids };
  }

  /** 加密 */
  async encrypt(plaintext: string, recipients: string[], signKeyID = ''): Promise<string> {
    if (recipients.length === 0) throw new Error('没有指定收件人公钥');
    if (!signKeyID) {
      const { secret } = await this.listKeys();
      const signer = secret.find(key => !key.expired && !key.revoked);
      signKeyID = signer?.fingerprint || signer?.keyID || '';
    }
    if (!signKeyID) throw new Error('发送必须签名：没有可用的签名私钥，请导入自己的私钥或插入硬件密钥');
    const args = ['--armor', '--trust-model', 'always', '--encrypt'];
    // Always encrypt a copy to the signing identity, regardless of UI recipient toggles.
    for (const r of new Set([...recipients, signKeyID])) args.push('--recipient', r);
    args.push('--sign', '--local-user', signKeyID);
    const res = await this.run(args, plaintext, 10 * 60 * 1000);
    if (res.code !== 0 || !res.stdout.includes('BEGIN PGP MESSAGE')) {
      throw new Error(`加密失败：${(res.stderr || res.error || '').trim()}`);
    }
    return res.stdout.trim();
  }

  /** 解密（同时解析签名状态） */
  decrypt(armored: string, resume = false, preferredKeyID = ''): Promise<DecryptResult> {
    if ((armored.match(/-----BEGIN PGP MESSAGE-----/g) ?? []).length !== 1) {
      return Promise.reject(new Error('请逐条解密完整的 PGP 消息，不能把多条密文合并解密'));
    }
    return decryptQueue.enqueue(JSON.stringify([this.accountScope, this.exePath, this.home, armored, preferredKeyID]), () => this.decryptNow(armored, preferredKeyID), resume);
  }

  private async decryptNow(armored: string, preferredKeyID = ''): Promise<DecryptResult> {
    // Hardware keys may need time to be inserted, unlocked and physically touched.
    const args = ['--status-fd', '2'];
    if (preferredKeyID.trim()) args.push('--try-secret-key', preferredKeyID.trim());
    args.push('--decrypt');
    const res = await this.run(args, armored, 10 * 60 * 1000);
    const decrypted = /^\[GNUPG:\] DECRYPTION_OKAY\r?$/m.test(res.stderr);
    const integrityFailed = /^\[GNUPG:\] (?:BADMDC|DECRYPTION_FAILED|NODATA)\b/m.test(res.stderr);
    // 缺少签名公钥也会让 gpg 以非零状态退出，但不妨碍已成功完成的解密。
    if (res.timedOut || integrityFailed || (res.code !== 0 && !decrypted)) {
      const err = (res.stderr || res.error || '').trim();
      log(`解密失败详情：${err}`);
      if (res.timedOut) throw new Error('等待硬件密钥超时，本条解密已停止；准备好密钥后可重新尝试');
      if (/card|CARDCTRL|SC_OP_FAILURE|scdaemon/i.test(err)) throw new Error('硬件密钥未就绪或操作已取消。请插入密钥后手动重试');
      if (/cancel|timeout|timed out|SIGTERM|killed/i.test(err)) throw new Error('解密已取消或等待超时，请准备好密钥后手动重试');
      if (/No secret key/i.test(err)) throw new Error('本机没有对应的私钥，无法解密');
      if (/passphrase|PIN|pinentry/i.test(err)) throw new Error('私钥需要口令，请在 GnuPG（Kleopatra）里解锁后重试');
      throw new Error('解密失败：密文不完整、格式无效或密钥不可用');
    }
    return { plaintext: res.stdout, signature: parseSignature(res.stderr) };
  }

  /** 删除密钥 */
  async deleteKey(keyID: string, secret: boolean): Promise<void> {
    if (secret) {
      const result = await this.run(['--delete-secret-keys', '--yes', keyID]);
      if (result.code !== 0) throw new Error(`删除私钥失败：${result.stderr || result.error}`);
    }
    const res = await this.run(['--delete-keys', '--yes', keyID]);
    if (res.code !== 0) {
      const err = (res.stderr || res.error || '').trim();
      if (!/not found|No such/i.test(err)) throw new Error(`删除失败：${err}`);
    }
  }

  /** 生成吊销证书（返回 armored 文本；硬件密钥需要 PIN / 口令） */
  async revokeKey(fingerprint: string): Promise<string> {
    // gen-revoke 会交互问：确认(y)、原因码(0=不再使用)、说明(空)、再确认(y)
    const res = await this.run(
      ['--no-batch', '--command-fd', '0', '--status-fd', '2', '--armor', '--gen-revoke', fingerprint],
      'y\n0\n\ny\n',
      120000
    );
    const text = res.stdout || '';
    const start = text.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    if (start < 0) {
      throw new Error(`生成吊销证书失败：${(res.stderr || res.error || text || '').trim().slice(0, 300)}`);
    }
    return text.slice(start);
  }

  /** 生成一个新的软件密钥对（存在本机 GnuPG 里） */
  async generateKey(name: string, email: string, passphrase = ''): Promise<string> {
    const uid = (email ? `${name} <${email}>` : name).trim();
    if (!uid) throw new Error('要填名字或邮箱');
    const res = await this.run(
      ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--status-fd', '2',
        '--quick-generate-key', uid, 'default', 'default', '0'],
      `${passphrase}\n`,
      300000
    );
    if (res.code !== 0) {
      throw new Error(`生成密钥失败：${(res.stderr || res.error || '').trim().slice(0, 300)}`);
    }
    const m = /\[GNUPG:\] KEY_CREATED \w ([0-9A-F]{40,64})/.exec(res.stderr)
      ?? /key ([0-9A-F]{16,40}) marked as ultimately trusted/.exec(res.stderr)
      ?? /([0-9A-F]{40})/.exec(res.stderr);
    return m?.[1] ?? '';
  }

  /** 给对方的公钥做本地认证（local signature，只在本机生效，不会上传 keyserver） */
  async certifyKey(fingerprint: string): Promise<void> {
    const res = await this.run(['--batch', '--yes', '--quick-lsign-key', fingerprint], undefined, 120000);
    if (res.code !== 0) {
      throw new Error(`认证失败：${(res.stderr || res.error || '').trim().slice(0, 300)}`);
    }
  }

  /** 设置信任级别（1~5，5=完全信任） */
  async setTrust(fingerprint: string, level: number): Promise<void> {
    const res = await this.run(['--import-ownertrust'], `${fingerprint}:${level}:\n`);
    if (res.code !== 0) {
      throw new Error(`设置信任失败：${(res.stderr || res.error || '').trim()}`);
    }
  }

  /** 从 keyserver 拉取密钥 */
  async recvKey(keyID: string, server: string): Promise<string> {
    const url = server.includes('://') ? server : `hkps://${server}`;
    const res = await this.run(['--keyserver', url, '--recv-keys', keyID]);
    if (res.code !== 0) {
      throw new Error(`从 ${server} 拉取失败：${(res.stderr || res.error || '').trim()}`);
    }
    return res.stderr;
  }

  /** 在 keyserver 上搜索密钥 */
  async searchKeyserver(query: string, server: string): Promise<KeySearchResult[]> {
    // 配置里只写域名（如 keys.openpgp.org），这里补协议
    const url = server.includes('://') ? server : `hkps://${server}`;
    const res = await this.run(['--keyserver', url, '--with-colons', '--search-keys', query]);
    const text = `${res.stdout}\n${res.stderr}`;
    // gpg 的 --search-keys --with-colons 输出格式：pub:指纹:算法:位数:创建时间:: / uid:URL编码的UID:时间::
    const colon = parseSearchColon(text);
    if (colon.length) return colon;
    return parseSearchResult(text, 'keyserver');
  }
}

/** 解析 `gpg --with-colons --list-keys` 输出 */
export function parseColonKeys(output: string): KeyInfo[] {
  const keys: KeyInfo[] = [];
  let current: KeyInfo | null = null;
  let currentIsSub = false;
  let subOwner: KeyInfo | null = null;

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const f = line.split(':');
    const type = f[0];
    if (type === 'pub' || type === 'sec') {
      current = {
        keyID: f[4] ?? '',
        fingerprint: '',
        algo: f[3] ?? '',
        bits: Number(f[2]) || 0,
        created: Number(f[5]) || 0,
        expires: Number(f[6]) || 0,
        expired: f[1] === 'e' || (Number(f[6]) > 0 && Number(f[6]) <= Date.now() / 1000),
        revoked: f[1] === 'r',
        secret: type === 'sec',
        validity: f[1] ?? '',
        userIds: [],
        subkeys: []
      };
      currentIsSub = false;
      subOwner = current;
      keys.push(current);
    } else if ((type === 'sub' || type === 'ssb') && current) {
      const sub: KeyInfo = {
        keyID: f[4] ?? '',
        fingerprint: '',
        algo: f[3] ?? '',
        bits: Number(f[2]) || 0,
        created: Number(f[5]) || 0,
        expires: Number(f[6]) || 0,
        expired: f[1] === 'e' || (Number(f[6]) > 0 && Number(f[6]) <= Date.now() / 1000),
        revoked: f[1] === 'r',
        secret: type === 'ssb',
        validity: f[1] ?? '',
        userIds: [],
        subkeys: []
      };
      current.subkeys.push(sub);
      currentIsSub = true;
    } else if (type === 'fpr' && current) {
      const fpr = f[9] ?? '';
      if (currentIsSub && subOwner && subOwner.subkeys.length) {
        subOwner.subkeys[subOwner.subkeys.length - 1]!.fingerprint = fpr;
      } else {
        current.fingerprint = fpr;
      }
    } else if (type === 'uid' && current) {
      const uid = f[9] ?? '';
      if (uid) current.userIds.push(decodeGpgUid(uid));
    }
  }
  return keys;
}

/** 从 `--status-fd 1` 的状态行里解析签名验证结果 */
export function parseSignature(output: string): SignatureInfo {
  const sig: SignatureInfo = { status: 'none' };
  for (const line of output.split('\n')) {
    if (!line.startsWith('[GNUPG:] ')) continue;
    const parts = line.slice(9).trim().split(' ');
    const tag = parts[0];
    if (tag === 'GOODSIG') {
      sig.status = 'good';
      sig.keyID = parts[1];
      sig.signer = parts.slice(2).join(' ');
    } else if (tag === 'BADSIG' || tag === 'EXPSIG' || tag === 'EXPKEYSIG' || tag === 'REVKEYSIG') {
      sig.status = 'bad';
      sig.keyID = parts[1];
    } else if (tag === 'ERRSIG') {
      sig.status = 'error';
      sig.keyID = parts[1];
    } else if (tag === 'NO_PUBKEY') {
      sig.status = 'nokey';
      sig.keyID = parts[1];
    } else if (tag === 'VALIDSIG') {
      sig.fingerprint = parts[1];
    } else if (tag === 'TRUST_ULTIMATE' || tag === 'TRUST_FULLY') {
      sig.trust = 'full';
    } else if (tag === 'TRUST_MARGINAL') {
      sig.trust = 'marginal';
    } else if (tag === 'TRUST_UNDEFINED') {
      sig.trust = 'undefined';
    } else if (tag === 'TRUST_NEVER') {
      sig.trust = 'never';
    }
  }
  return sig;
}

function decodeGpgUid(uid: string): string {
  return uid.replace(/(?:\\x[0-9a-f]{2})+/gi, escaped =>
    Buffer.from(escaped.split('\\x').slice(1).map(hex => parseInt(hex, 16))).toString('utf8'));
}

/** 解析 `gpg --search-keys --with-colons` 的输出（pub:指纹:算法:位数:创建时间:: / uid:URL编码:时间::） */
export function parseSearchColon(text: string): KeySearchResult[] {
  const results: KeySearchResult[] = [];
  let current: KeySearchResult | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('info:') || line.startsWith('gpg:')) continue;
    const f = line.split(':');
    if (f[0] === 'pub') {
      const fp = f[1] ?? '';
      if (!fp) continue;
      current = {
        keyID: fp.slice(-16),
        fingerprint: fp,
        algo: f[2] ?? '',
        bits: Number(f[3]) || 0,
        created: Number(f[4]) || 0,
        expires: 0,
        userIds: [],
        source: 'keyserver'
      };
      results.push(current);
    } else if (f[0] === 'uid' && current) {
      let uid = f[1] ?? '';
      try {
        uid = decodeURIComponent(uid);
      } catch { /* 保持原样 */ }
      if (uid) current.userIds.push(uid);
    }
  }
  return results;
}

/** 解析 `gpg --search-keys` 的输出（gpg 输出的是人读文本，这里粗略解析） */
export function parseSearchResult(text: string, source: 'keyserver' | 'github'): KeySearchResult[] {
  const results: KeySearchResult[] = [];
  const blocks = text.split(/\n\s*\(\d+\)\s+/);
  blocks.shift();
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const head = lines[0] ?? '';
    const uid = (lines.find(l => l.includes('@')) ?? '').trim();
    const infoLine = (lines.find(l => /\d{4}-\d{2}-\d{2}/.test(l)) ?? '').trim();
    const algoMatch = /(\d+)\s*-?\s*bit\s*(\w+)/i.exec(infoLine) ?? /(\w+)\s*key\s*(\d+)/i.exec(head);
    const dateMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(infoLine);
    const keyIDMatch = /([0-9A-F]{8,40})\s*$/.exec(head.trim());
    if (!keyIDMatch) continue;
    results.push({
      keyID: keyIDMatch[1] ?? '',
      fingerprint: keyIDMatch[1] ?? '',
      algo: algoMatch ? String(algoMatch[2] ?? '') : '',
      bits: algoMatch ? Number(algoMatch[1]) || 0 : 0,
      created: dateMatch ? Math.floor(new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`).getTime() / 1000) : 0,
      expires: 0,
      userIds: uid ? [uid] : [],
      source
    });
  }
  return results;
}
