import { defineDoc } from '@earendil-works/pi-durable';

export type HealthDay = {
  date: string; steps: number | null; activeEnergyKcal: number | null;
  sleepMinutes: number | null; restingHeartRate: number | null; workoutMinutes: number | null;
};
export type HealthSource = { deviceId: string; enabled: boolean; capturedAt: string | null; receivedAt: string | null; uploadId: string | null; timezone: string; days: HealthDay[] };
export const HealthDoc = defineDoc<{ sources: HealthSource[] }>({ kind: 'friday.health', version: 1, scope: 'session', initial: () => ({ sources: [] }) });
export function timezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new Error('时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new Error('时区无效'); }
  return value;
}
export function localDate(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-');
}
export function healthUpload(body: any, at = Date.now()) {
  const zone = timezone(body.timezone);
  if (typeof body.uploadId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.uploadId)) throw new Error('同步 ID 无效');
  const captured = typeof body.capturedAt === 'string' ? Date.parse(body.capturedAt) : NaN;
  if (!Number.isFinite(captured) || captured > at + 5 * 60_000 || captured < at - 30 * 86400_000) throw new Error('采集时间无效，请检查手机时间或重新同步');
  if (!Array.isArray(body.days) || body.days.length < 1 || body.days.length > 14) throw new Error('每次同步需包含最近 1 至 14 天的健康摘要');
  const latest = localDate(captured, zone); const earliest = localDate(captured - 14 * 86400_000, zone);
  const dates = new Set<string>();
  const bounds = { steps: 200000, activeEnergyKcal: 20000, sleepMinutes: 1440, restingHeartRate: 300, workoutMinutes: 1440 };
  const days: HealthDay[] = body.days.map((day: any) => {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date || day.date < earliest || day.date > latest || dates.has(day.date)) throw new Error('摘要日期无效或重复');
    dates.add(day.date);
    const metrics: Record<string, number | null> = {};
    for (const [name, max] of Object.entries(bounds)) {
      const value = day[name] === undefined ? null : day[name];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)) throw new Error(`健康指标 ${name} 无效；缺失数据请用 null`);
      metrics[name] = value;
    }
    return { date: day.date, ...metrics } as HealthDay;
  }).sort((a: HealthDay, b: HealthDay) => a.date.localeCompare(b.date));
  return { uploadId: body.uploadId as string, capturedAt: new Date(captured).toISOString(), timezone: zone, days };
}

// Search local wall-clock minutes rather than adding 24 hours across DST changes.
export function nextDaily(at: number, hour: number, minute: number, zone: string): number {
  const format = new Intl.DateTimeFormat('en', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  for (let candidate = Math.floor(at / 60_000) * 60_000 + 60_000, end = candidate + 49 * 3600_000; candidate < end; candidate += 60_000) {
    const parts = format.formatToParts(candidate);
    if (Number(parts.find(p => p.type === 'hour')!.value) === hour && Number(parts.find(p => p.type === 'minute')!.value) === minute) return candidate;
  }
  throw new Error('无法计算下次分享时间');
}

export function healthBrief(source: HealthSource | undefined, at: number, zone: string): string {
  if (!source?.capturedAt) return '今天的健康分享：还没有收到手机健康数据。请在 iPhone 的「健康与主动分享」中开启同步；数据到达后我会继续关注。';
  const today = localDate(at, source.timezone);
  const yesterday = localDate(Date.parse(`${today}T12:00:00Z`) - 86400_000, 'UTC');
  const activity = source.days.find(day => day.date === yesterday);
  const sleep = source.days.find(day => day.date === today);
  const show = (value: number | null | undefined, unit: string) => value == null ? '暂无数据' : `${Math.round(value)}${unit}`;
  return `今天的健康分享\n\n昨夜睡眠：${show(sleep?.sleepMinutes, ' 分钟')}（按起床日归档）。\n昨日（${yesterday}）：步数 ${show(activity?.steps, ' 步')}；活动能量 ${show(activity?.activeEnergyKcal, ' 千卡')}；运动 ${show(activity?.workoutMinutes, ' 分钟')}；静息心率 ${show(activity?.restingHeartRate, ' 次/分钟')}。\n\n摘要日期使用手机时区 ${source.timezone}，手机最近采集于 ${source.capturedAt}。缺失数据表示尚未取得可用样本。${at - Date.parse(source.capturedAt) > 18 * 3600_000 ? '数据尚未更新，请在手机解锁并连通主机后补同步。' : ''}`;
}
