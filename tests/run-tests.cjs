const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectRoot, projectPath } = require('./support/paths.cjs');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) console.error(result.error.message);
  // A process killed by a signal or failing to start has status=null, not success.
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const compiler = require.resolve('typescript/lib/tsc.js');
const buildRoot = path.resolve(__dirname, '.build');
// Do not let a stale compilation hide a missing source entry or dependency.
if (path.dirname(buildRoot) !== __dirname || path.basename(buildRoot) !== '.build') {
  throw new Error(`Unexpected test build directory: ${buildRoot}`);
}
fs.rmSync(buildRoot, { recursive: true, force: true });
const builds = [
  ['core', ['core/index.ts']],
  ['feedback', ['view/OriginalFeedbackMath.ts', 'view/OriginalParticleSimulation.ts', 'view/OriginalWeaponConfettiMath.ts', 'view/WeaponGradeEffectSimulation.ts']],
  ['character', ['view/OriginalCatAnimation.ts', 'view/WeaponAttackAnimation.ts', 'view/PetAnimation.ts']],
  ['color', ['view/OriginalColorMath.ts']],
  ['session', ['session/BattleSession.ts', 'session/RuntimeEnvironment.ts', 'session/TutorialPreview.ts', 'session/GameLogin.ts', 'session/EarlyWechatLogin.ts', 'session/GameBackendConfig.ts', 'session/CloudSaveStorage.ts', 'platform/PlatformServices.ts']],
  ['money', ['view/MoneyBurstSimulation.ts']],
];
for (const [output, entries] of builds) {
  run([compiler, '--target', 'ES2018', '--module', 'commonjs', '--strict', '--skipLibCheck',
    '--outDir', path.join(buildRoot, output), ...entries.map(entry => projectPath('assets/scripts', entry))]);
}
const tests = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.cjs')).sort();
if (tests.length === 0) throw new Error('No tests found in Project/tests.');
run(['--test', ...process.argv.slice(2), ...tests.map(name => path.join(__dirname, name))]);
