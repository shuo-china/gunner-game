// Records the renderer boundary, without pretending individual glyphs remain
// scene nodes. OrderedQuadBatch's real Cocos assembler has separate fixtures.
class NumberBatchHarness {
  constructor(art, parent) { this.art=art;this.parent=parent;this.quads=[];this.submissions=0; }
  begin() { this.quads=[]; }
  add(frame,x,y,width,height,anchorX,anchorY,angle,color) {
    this.quads.push({frame,x,y,width,height,anchorX,anchorY,angle,color:Array.from(color)});
  }
  end() { this.submissions++; }
  diagnostics() { return { activeQuads:this.quads.length }; }
}
module.exports={NumberBatchHarness};
