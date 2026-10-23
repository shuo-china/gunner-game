// Capture the actual renderer output, including baked font atlas selection.
function gradeBadgeRendering(node, { UITransform, Label, Sprite }) {
  const geometry = node => { const tr = node.getComponent(UITransform); return [node.angle, node.scale.x, node.scale.y,
    node.position.x, node.position.y, tr.width, tr.height, tr.anchorX, tr.anchorY]; };
  const label = node.getComponent(Label);
  return JSON.parse(JSON.stringify({ geometry: geometry(node), text: label.string, fontSize: label.fontSize, color: label.color,
    glyphs: node.children.filter(child => child.name === 'OriginalGlyph' && child.active).map(child => {
      const sprite = child.getComponent(Sprite);
      return { geometry: geometry(child), color: sprite.color, page: sprite.spriteFrame.texture.path, rect: sprite.spriteFrame.rect };
    }) }));
}
module.exports = { gradeBadgeRendering };
