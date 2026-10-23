'use strict';

// Preserve negative zero as well as every authored coordinate and mesh property.
function stringify(value) {
  if (Object.is(value, -0)) return '-0';
  if (Array.isArray(value)) return '[' + value.map(stringify).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .map(([key, item]) => JSON.stringify(key) + ':' + stringify(item)).join(',') + '}';
  return JSON.stringify(value);
}

function compactMeshMetadata(metadata) {
  const candidates = new Map(), parsed = new Map();
  const inspect = (value, location, file) => {
    if (!value || typeof value !== 'object') return;
    if (location.at(-1) === 'mesh' && Array.isArray(value.positions) && Array.isArray(value.uv) && Array.isArray(value.indices)) {
      const signature = stringify({ positions: value.positions, uv: value.uv, indices: value.indices });
      if (signature.length >= 1024) {
        if (!candidates.has(signature)) candidates.set(signature, []);
        candidates.get(signature).push({ file, path: location, value });
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) inspect(child, location.concat(key), file);
  };
  for (const [file, text] of Object.entries(metadata.files)) {
    const value = JSON.parse(text); parsed.set(file, value); inspect(value, [], file);
  }
  const meshGeometries = [], meshes = {}, files = { ...metadata.files };
  let copiesRemoved = 0, bytesAvoided = 0;
  for (const [signature, matches] of candidates) {
    if (matches.length < 2) continue;
    const index = meshGeometries.length; meshGeometries.push(signature);
    copiesRemoved += matches.length - 1;
    bytesAvoided += (matches.length - 1) * Buffer.byteLength(signature);
    for (const match of matches) {
      if (!meshes[match.file]) meshes[match.file] = [];
      meshes[match.file].push({ path: match.path, index });
      // Keep colors, source IDs and any other per-effect data independent.
      delete match.value.positions; delete match.value.uv; delete match.value.indices;
    }
  }
  if (!meshGeometries.length) return { metadata, copiesRemoved, bytesAvoided };
  for (const file of Object.keys(meshes)) files[file] = stringify(parsed.get(file));
  return { metadata: { ...metadata, version: 3, files, fontMetrics: metadata.fontMetrics || [],
    fonts: metadata.fonts || {}, meshGeometries, meshes }, copiesRemoved, bytesAvoided };
}
module.exports = { compactMeshMetadata };
