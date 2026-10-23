const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const generatedConfig = path.join(projectRoot, 'temp/tsconfig.cocos.json');
if (!fs.existsSync(generatedConfig)) {
  console.error('Creator configuration is missing: temp/tsconfig.cocos.json.');
  console.error('Open this project in Cocos Creator 3.8.8 to generate its engine declarations, then run npm run typecheck again.');
  console.error('The standalone regression suite can still run with npm test.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--noEmit', '--project', projectRoot],
  { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
