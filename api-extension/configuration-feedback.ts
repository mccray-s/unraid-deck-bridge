// Forward only public field paths and structured feedback.
export const configurationFields = new Set<string>([
  'name',
  'image',
  'network',
  'networks',
  'privileged',
  'start',
  'autoStart',
  'environment',
  'labels',
  'ports',
  'mounts',
  'metadata',
  'metadata.iconUrl',
  'metadata.webUi',
  'metadata.shell',
  'extraParams',
  'postArgs',
  'runtime',
  'runtime.user',
  'runtime.workingDir',
  'runtime.hostname',
  'runtime.domainname',
  'runtime.stopSignal',
  'runtime.restartPolicy',
  'runtime.logDriver',
  'runtime.cpuSet',
  'runtime.cpuSetMems',
  'runtime.runtime',
  'runtime.pidMode',
  'runtime.ipcMode',
  'runtime.utsMode',
  'runtime.usernsMode',
  'runtime.cgroupnsMode',
  'runtime.cgroupParent',
  'runtime.entrypoint',
  'runtime.cmd',
  'runtime.groupAdd',
  'runtime.capAdd',
  'runtime.capDrop',
  'runtime.securityOpt',
  'runtime.dns',
  'runtime.dnsSearch',
  'runtime.dnsOptions',
  'runtime.extraHosts',
  'runtime.devices',
  'runtime.gpus',
  'runtime.ulimits',
  'runtime.deviceCgroupRules',
  'runtime.stopTimeout',
  'runtime.restartRetries',
  'runtime.memory',
  'runtime.memorySwap',
  'runtime.memoryReservation',
  'runtime.memorySwappiness',
  'runtime.nanoCpus',
  'runtime.cpuShares',
  'runtime.cpuQuota',
  'runtime.cpuPeriod',
  'runtime.pidsLimit',
  'runtime.shmSize',
  'runtime.oomScoreAdj',
  'runtime.init',
  'runtime.openStdin',
  'runtime.tty',
  'runtime.readOnlyRootfs',
  'runtime.autoRemove',
  'runtime.oomKillDisable',
  'runtime.logOptions',
  'runtime.sysctls',
  'runtime.storageOptions',
  'runtime.tmpfs',
  'runtime.healthcheck',
  'runtime.healthcheck.test',
  'runtime.healthcheck.interval',
  'runtime.healthcheck.timeout',
  'runtime.healthcheck.startPeriod',
  'runtime.healthcheck.startInterval',
  'runtime.healthcheck.retries',
]);
configurationFields.add('templateFields');
configurationFields.add('templateFields.defaultValue');
const record = (v: any) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: any, n: number) =>
  typeof v === 'string' && v.length <= n && !/[\x00-\x1f\x7f]/.test(v);
export function safeIssue(value: any): any {
  if (!record(value) || !configurationFields.has(value.field)) return undefined;
  if (
    value.index != null &&
    (!Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index > 2147483647)
  )
    return undefined;
  if (
    value.target != null &&
    (!bounded(value.target, 512) ||
      ![
        'mounts',
        'environment',
        'labels',
        'ports',
        'networks',
        'runtime.devices',
        'templateFields',
        'templateFields.defaultValue',
      ].includes(value.field))
  )
    return undefined;
  const result: any = { field: value.field };
  if (value.target != null) result.target = value.target;
  if (value.index != null) result.index = value.index;
  return result;
}
export function safeChangeSummary(value: any): any[] {
  if (!Array.isArray(value)) throw new Error('Invalid change summary');
  return value.map((item) => {
    if (
      !record(item) ||
      !configurationFields.has(item.field) ||
      !['ADDED', 'MODIFIED', 'REMOVED', 'CHANGED'].includes(item.kind) ||
      typeof item.sensitive !== 'boolean'
    )
      throw new Error('Invalid change summary');
    if (item.target != null && !bounded(item.target, 512))
      throw new Error('Invalid change target');
    const result: any = {
      field: item.field,
      kind: item.kind,
      sensitive: item.sensitive,
    };
    if (item.target != null) result.target = item.target;
    if (!item.sensitive && item.field !== 'templateFields')
      for (const key of ['before', 'after'])
        if (item[key] != null) {
          if (!bounded(item[key], 4096))
            throw new Error('Invalid change value');
          result[key] = item[key];
        }
    return result;
  });
}
