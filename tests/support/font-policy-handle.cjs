// HUD/controller tests isolate layout and interaction from the text renderer.
// Actual glyph selection, measurement and rendering are exercised separately.
exports.attachFontPolicyLabel = (label, _art, font) => {
  label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif'; label.enabled = false;
  const handle = { sync() { label.policyText = label.string; label.policyFont = font; }, destroy() { handle.destroyed = true; } };
  handle.sync();
  return handle;
};
