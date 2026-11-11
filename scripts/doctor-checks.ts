import type { AppConfig } from '../src/domain.js';
import { readiness, type ReadinessItem } from '../src/readiness.js';

export interface DoctorCheck { name: string; ready: boolean; detail: string; live: boolean }
export interface DoctorCommand { ready: boolean; detail: string }

/** Demo and test output stays explicitly non-live. Missing host dependencies stay unready. */
export function collectDoctorChecks(config: AppConfig, nodeVersion: string, command: (name: string) => DoctorCommand): DoctorCheck[] {
  const liveMode = config.mode === 'live';
  const tag = (item: ReadinessItem): DoctorCheck => ({ ...item, live: liveMode && item.ready });
  const checks: DoctorCheck[] = [tag({ name: 'Node.js 24', ready: nodeVersion.startsWith('24.'), detail: nodeVersion }), ...readiness(config).map(tag)];
  if (!liveMode) checks.push({ name: 'live 准入', ready: false, live: false, detail: '模拟数据不能标成 live。' });
  for (const name of ['limactl', 'restic']) {
    const probe = command(name);
    checks.push({ name, ready: probe.ready, detail: probe.detail, live: liveMode && probe.ready });
  }
  return checks;
}
