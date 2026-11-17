import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { userInfo } from 'node:os';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);

const usage = `
在已选的非 root 测试登录中从仓库根运行：
  node deploy/obsidian/rehearsal.mjs init --test-user USER --test-uid UID --service-uid UID
  node deploy/obsidian/rehearsal.mjs watch --test-user USER --test-uid UID --service-uid UID --session ID --phase editor-open|editor-closed|after-restart [--seconds 180]
  node deploy/obsidian/rehearsal.mjs sample-save --test-user USER --test-uid UID --service-uid UID --session ID --phase editor-closed|after-restart
  node deploy/obsidian/rehearsal.mjs status --test-user USER --test-uid UID --service-uid UID --session ID

命令不接受任意 Vault 路径、生产账本、账号令牌，也不启动或退出 Obsidian。
本版只验证编辑者和后台演练进程共用同一非 root UID 的部署。
`.trim();

function parse(argv) {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      help: { type: 'boolean' }, 'test-user': { type: 'string' }, 'test-uid': { type: 'string' },
      'service-uid': { type: 'string' }, session: { type: 'string' }, phase: { type: 'string' }, seconds: { type: 'string' },
    },
  });
  if (values.help) return null;
  const [command] = positionals;
  if (positionals.length !== 1 || !['init', 'watch', 'sample-save', 'status'].includes(command)) throw new Error('REHEARSAL_COMMAND_INVALID');
  if (!values['test-user'] || !/^\d+$/.test(values['test-uid'] ?? '') || !/^\d+$/.test(values['service-uid'] ?? '')) {
    throw new Error('REHEARSAL_EXPLICIT_LOGIN_REQUIRED');
  }
  const phased = command === 'watch' || command === 'sample-save';
  if ((command === 'init') !== (values.session === undefined) ||
      phased !== (values.phase !== undefined) || command !== 'watch' && values.seconds !== undefined) {
    throw new Error('REHEARSAL_ARGUMENTS_INVALID');
  }
  const seconds = Number(values.seconds ?? 180);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 600) throw new Error('REHEARSAL_TIMEOUT_INVALID');
  return { command, sessionId: values.session, phase: values.phase, timeoutMs: seconds * 1000, input: {
    testUser: values['test-user'], testUid: Number(values['test-uid']), serviceUid: Number(values['service-uid']),
  } };
}

async function main() {
  const argv = parse(process.argv.slice(2));
  if (!argv) {
    console.log(usage);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('REHEARSAL_MACOS_REQUIRED');
  const euid = process.geteuid();
  const realUid = process.getuid();
  const selected = userInfo();
  if (euid <= 0 || argv.input.testUid <= 0) throw new Error('REHEARSAL_NON_ROOT_REQUIRED');
  if (argv.input.testUid !== euid || euid !== realUid || selected.uid !== euid || selected.username !== argv.input.testUser) {
    throw new Error('REHEARSAL_LOGIN_MISMATCH');
  }
  if (argv.input.serviceUid !== euid) throw new Error('REHEARSAL_SEPARATE_SERVICE_UID_UNSUPPORTED');
  async function consoleOwner() {
    if ((await stat('/dev/console')).uid !== euid) throw new Error('REHEARSAL_DESKTOP_LOGIN_NOT_ACTIVE');
  }
  await consoleOwner();

  // The repository uses JS specifiers for TypeScript source; apply the same resolution on native Node.
  const repository = new URL('../../', import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND' &&
            context.parentURL?.startsWith(repository) && !context.parentURL.includes('/node_modules/') &&
            specifier.startsWith('.') && specifier.endsWith('.js')) {
          return nextResolve(specifier.slice(0, -3) + '.ts', context);
        }
        throw error;
      }
    },
  });
  const { createRehearsal } = await import('./rehearsal.ts');
  const { observeProcess, observeSignedEditor } = await import('./rehearsal-observation.ts');
  const rehearsal = createRehearsal({
    username: selected.username, uid: euid, realUid, home: selected.homedir,
    async observeEditor() {
      await consoleOwner();
      return observeSignedEditor(euid);
    },
    observeProcess,
    async observeBoot() {
      try {
        const { stdout } = await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 3000 });
        const uuid = stdout.trim();
        return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) ? uuid.toUpperCase() : null;
      } catch { return null; }
    },
  }, argv.input);

  let result;
  if (argv.command === 'init') {
    const session = await rehearsal.init();
    result = { ...session, 操作: [
      '只在此测试桌面，手动打开 Obsidian，选择“打开文件夹为仓库”，只选择下面的合成目录：' + session.vaultPath,
      '先运行 editor-open 阶段的 watch。等它提示“正在等待”后，再在 Obsidian 源码模式打开两个指定文件。',
      '在原文末尾保留一个空行，然后逐字粘贴相应的 marker，各自保存。不要替换正文或 Properties。',
      '检查系统视图的索引和候选。程序不会把进程存在当成 GUI 保存来源；请人工记录实际打开、保存和显示结果。',
    ] };
  } else if (argv.command === 'watch') {
    result = await rehearsal.watch(argv.sessionId, argv.phase, { timeoutMs: argv.timeoutMs, onReady(worker) {
      console.error(`演练进程 ${worker.pid} 正在等待 ${argv.phase}：` + (argv.phase === 'editor-open'
        ? '现在在测试 Obsidian 中保存两个合成标记。'
        : '保持测试 Obsidian 退出，在同一登录的第二个终端运行本阶段 sample-save。'));
    } });
  } else if (argv.command === 'sample-save') {
    result = await rehearsal.saveClosedSample(argv.sessionId, argv.phase);
  } else {
    result = await rehearsal.status(argv.sessionId);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
