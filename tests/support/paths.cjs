const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');
const projectPath = (...parts) => path.join(projectRoot, ...parts);
const fixturePath = (...parts) => path.join(__dirname, '..', 'fixtures', ...parts);

module.exports = { projectRoot, projectPath, fixturePath };
