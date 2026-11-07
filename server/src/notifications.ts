import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { defineDoc } from '@earendil-works/pi-durable';

export type PushDevice = { deviceId: string; token: string; environment: 'development' | 'production' };
export type PushResult = { status: 'accepted' | 'retry' | 'failed' | 'uncertain' | 'unavailable'; reason?: string; invalidToken?: boolean };
export interface PushSender { configured: boolean; initialize?(): Promise<void>; send(device: PushDevice, id: string, taskId: string, signal: AbortSignal): Promise<PushResult> }
export type Delivery = { id: string; deviceId: string; taskId: string; status: string; attempts: number; expiresAt: number; error?: string };
export const PushDoc = defineDoc<{ devices: PushDevice[]; deliveries: Delivery[] }>({ kind: 'friday.notifications', version: 1, scope: 'session', initial: () => ({ devices: [], deliveries: [] }) });
type SavedApns = { keyId: string; teamId: string; topic: string; privateKey: string };
function validatedApns(value: unknown): SavedApns {
  if (!value || typeof value !== 'object') throw new Error('推送配置无效');
  const { keyId, teamId, topic, privateKey } = value as Record<string, unknown>;
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(keyId) || typeof teamId !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(teamId)) throw new Error('请输入有效的 Key ID 和 Team ID');
  if (typeof topic !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}$/.test(topic)) throw new Error('请输入签名 iOS App 的 Bundle Identifier');
  if (typeof privateKey !== 'string' || privateKey.length > 16384) throw new Error('请选择 APNs 的 .p8 私钥');
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
  } catch { throw new Error('密钥不是有效的 APNs P-256 私钥，请重新选择 .p8 文件'); }
  return { keyId, teamId, topic, privateKey };
}

export class ApnsSender implements PushSender {
  private saved?: SavedApns;
  private loading?: Promise<void>;
  private mutation: Promise<unknown> = Promise.resolve();
  private error?: string;
  constructor(private env: NodeJS.ProcessEnv = process.env, private connectionFactory: typeof connect = connect, private authFile?: string) {}
  get configured() { return !!this.saved || ['FRIDAY_APNS_KEY_PATH', 'FRIDAY_APNS_KEY_ID', 'FRIDAY_APNS_TEAM_ID', 'FRIDAY_APNS_TOPIC'].every(key => !!this.env[key]); }
  initialize(): Promise<void> {
    return this.loading ??= (async () => {
      if (!this.authFile) return;
      try {
        this.saved = validatedApns(JSON.parse(await readFile(this.authFile, 'utf8')));
        await chmod(this.authFile, 0o600);
      } catch (error) {
        this.saved = undefined;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = '主机保存的 APNs 配置不可用，请重新保存';
      }
    })();
  }
  status(owner: boolean) {
    if (!owner) return { configured: this.configured };
    return { configured: this.configured, source: this.saved ? 'file' : this.configured ? 'environment' : 'none',
      keyId: this.saved?.keyId ?? this.env.FRIDAY_APNS_KEY_ID ?? '', teamId: this.saved?.teamId ?? this.env.FRIDAY_APNS_TEAM_ID ?? '',
      topic: this.saved?.topic ?? this.env.FRIDAY_APNS_TOPIC ?? '', error: this.error ?? null };
  }
  async save(value: unknown) {
    await this.initialize();
    const operation = this.mutation.then(async () => {
      if (!this.authFile) throw new Error('当前运行方式不支持保存推送配置');
      const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const next = validatedApns({ keyId: input.keyId, teamId: input.teamId, topic: input.topic, privateKey: input.privateKey ?? this.saved?.privateKey });
      const temporary = `${this.authFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.authFile);
      } catch { throw new Error('无法保存主机推送配置，请检查数据目录权限'); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.saved = next; this.error = undefined;
      return this.status(true);
    });
    this.mutation = operation.catch(() => {}); return operation;
  }
  async clear() {
    await this.initialize();
    const operation = this.mutation.then(async () => {
      if (!this.authFile) throw new Error('当前运行方式不支持移除推送配置');
      try { await rm(this.authFile, { force: true }); } catch { throw new Error('无法移除主机推送配置'); }
      this.saved = undefined; this.error = undefined; return this.status(true);
    });
    this.mutation = operation.catch(() => {}); return operation;
  }
  async send(device: PushDevice, id: string, taskId: string, signal: AbortSignal): Promise<PushResult> {
    await this.initialize();
    if (!this.configured) return { status: 'unavailable', reason: '主机尚未配置 APNs' };
    let jwt: string; let topic: string;
    try {
      // Capture one credential version before network I/O, including key rotation.
      const auth = this.saved ?? { keyId: this.env.FRIDAY_APNS_KEY_ID!, teamId: this.env.FRIDAY_APNS_TEAM_ID!, topic: this.env.FRIDAY_APNS_TOPIC!, privateKey: await readFile(this.env.FRIDAY_APNS_KEY_PATH!, 'utf8') };
      const key = createPrivateKey(auth.privateKey); topic = auth.topic;
      const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encoded({ alg: 'ES256', kid: auth.keyId })}.${encoded({ iss: auth.teamId, iat: Math.floor(Date.now() / 1000) })}`;
      jwt = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    } catch { return { status: 'failed', reason: '无法读取或使用 APNs 签名密钥' }; }
    signal.throwIfAborted();
    return new Promise(resolve => {
      let client: ClientHttp2Session;
      try { client = this.connectionFactory(device.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'); }
      catch { resolve({ status: 'retry', reason: '无法建立 APNs 连接' }); return; }
      let finished = false; let submitted = false;
      const finish = (result: PushResult) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', aborted); client.destroy(); resolve(result); };
      const aborted = () => finish({ status: submitted ? 'uncertain' : 'retry', reason: '发送已中断' });
      const timer = setTimeout(() => finish({ status: submitted ? 'uncertain' : 'retry', reason: 'APNs 响应超时' }), 12000);
      signal.addEventListener('abort', aborted, { once: true });
      client.on('error', () => finish({ status: submitted ? 'uncertain' : 'retry', reason: '无法确认 APNs 发送结果' }));
      client.on('connect', () => {
        if (finished) return;
        let request: ClientHttp2Stream;
        try {
          request = client.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${jwt}`,
            'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': id,
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600) });
        } catch { finish({ status: 'retry', reason: 'APNs 连接已关闭，等待重试' }); return; }
        let status = 0; let body = '';
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', data => { if (body.length < 4096) body += data.toString(); });
        request.on('error', () => finish({ status: 'uncertain', reason: '无法确认 APNs 发送结果' }));
        request.on('end', () => {
          if (status === 200) return finish({ status: 'accepted' });
          let reason = `APNs ${status}`;
          try { const parsed = JSON.parse(body); if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 100); } catch {}
          finish({ status: status === 429 || status >= 500 ? 'retry' : 'failed', reason,
            invalidToken: status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' });
        });
        submitted = true;
        try { request.end(JSON.stringify({ aps: { alert: { title: 'Friday', body: '今天的健康分享已准备好，点开继续聊。' }, sound: 'default', 'thread-id': 'friday-health' }, taskId, deliveryId: id })); }
        catch { finish({ status: 'uncertain', reason: '无法确认 APNs 发送结果' }); }
      });
    });
  }
}
