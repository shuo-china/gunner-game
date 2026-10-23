import { Material, Node, Sprite, SpriteFrame } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { ORIGINAL_WORLD_LAYER } from './OriginalColorMath';

const WHITE = [1, 1, 1, 1] as const;
// 36 KiB of vertices fits comfortably in Creator's default 144 KiB accessor.
// Runs split before allocation, so a dense burst never requests a giant chunk.
const MAX_QUADS_PER_RUN = 256;
const STRIDE = 9;

/** Ordered, already-projected quads. Only consecutive compatible draws merge;
 * sorting transparent glyphs/particles by texture would change their image. */
export class OrderedQuadBatch {
  private readonly node: Node;
  private readonly runs: QuadRun[] = [];
  private activeRuns = 0;
  private activeQuads = 0;
  private disposed = false;

  constructor(private readonly art: ArtLibrary, parent: Node, name = 'OrderedQuadBatch') {
    this.node = makeNode(name, parent);
    this.node.once(Node.EventType.NODE_DESTROYED, this.release, this);
  }

  begin(): void {
    if (this.disposed) return;
    this.activeRuns = 0; this.activeQuads = 0;
  }

  /** Same geometry as a CUSTOM-size Sprite with trim=false. Colors are floats;
   * caller-owned arrays are copied immediately and can be reused for all quads. */
  add(frame: SpriteFrame, x: number, y: number, width: number, height: number,
    anchorX = .5, anchorY = .5, angle = 0, color: readonly number[] = WHITE,
    material?: Material | null): void {
    if (this.disposed) return;
    // Never let Sprite's dynamic-atlas path silently replace a run's texture.
    // Already packed frames are valid too: consume their actual four UV pairs.
    frame.packable = false;
    const resolvedMaterial = material === undefined
      ? (this.node.layer === ORIGINAL_WORLD_LAYER ? this.art.linearSpriteMaterial ?? null : null) : material;
    let run = this.activeRuns ? this.runs[this.activeRuns - 1] : undefined;
    if (!run || run.count >= run.limit || run.texture !== frame.texture || run.material !== resolvedMaterial) {
      run = this.runs[this.activeRuns];
      if (!run) {
        run = new QuadRun(makeNode(`Run_${this.activeRuns}`, this.node));
        this.runs.push(run);
      }
      run.begin(frame, resolvedMaterial); this.activeRuns++;
    }
    run.add(frame, x, y, width, height, anchorX, anchorY, angle, color);
    this.activeQuads++;
  }

  end(): void {
    if (this.disposed) return;
    for (let i = 0; i < this.runs.length; i++) {
      if (i < this.activeRuns) this.runs[i].end();
      else this.runs[i].hide();
    }
  }

  diagnostics(): { activeQuads: number; activeRuns: number; pooledRuns: number; capacityQuads: number } {
    let capacityQuads = 0;
    for (const run of this.runs) capacityQuads += run.capacity;
    return { activeQuads: this.activeQuads, activeRuns: this.activeRuns, pooledRuns: this.runs.length, capacityQuads };
  }

  destroy(): void {
    this.release();
    if (this.node.isValid) this.node.destroy();
  }

  private release(): void {
    if (this.disposed) return;
    this.disposed = true; this.activeQuads = 0; this.activeRuns = 0;
    // Sprite owns RenderData/chunks; Node destruction recycles those once.
    this.runs.length = 0;
  }
}

class QuadRun {
  readonly sprite: Sprite;
  texture: SpriteFrame['texture'] | null = null;
  material: Material | null = null;
  count = 0;
  capacity = 0;
  limit = MAX_QUADS_PER_RUN;
  private vertices = new Float32Array(0);
  private indices = new Uint16Array(0);
  private drawIndices = new Uint16Array(0);
  private activeIndices = new Uint16Array(0);

  constructor(readonly node: Node) {
    this.sprite = node.addComponent(Sprite);
    this.sprite.sizeMode = Sprite.SizeMode.CUSTOM; this.sprite.trim = false;
    const bridge = this.sprite as any;
    // Creator 3.8.8's assembler seam, isolated here like OriginalParticleMesh.
    bridge.destroyRenderData();
    bridge._assembler = {
      createData: () => this.createData(),
      updateRenderData: () => this.updateRenderData(),
      fillBuffers: () => this.fillBuffers(),
      updateUVs: () => this.sprite.markForUpdateRenderData(),
      updateColor: () => this.sprite.markForUpdateRenderData(),
    };
    bridge._flushAssembler = () => {
      if (!bridge._renderData) bridge._renderData = this.createData();
    };
    // VERTEX=1 in 3.8.8: prevents Batcher2D from replacing every quad's alpha
    // with one Sprite alpha. fillBuffers applies the current cascaded opacity.
    bridge.setFillColorType(1);
    bridge._flushAssembler();
    this.node.active = false;
  }

  begin(frame: SpriteFrame, material: Material | null): void {
    this.count = 0; this.texture = frame.texture; this.material = material;
    if (this.sprite.customMaterial !== material) this.sprite.customMaterial = material;
    if (this.sprite.spriteFrame !== frame) this.sprite.spriteFrame = frame;
  }

  add(frame: SpriteFrame, x: number, y: number, width: number, height: number,
    anchorX: number, anchorY: number, angle: number, color: readonly number[]): void {
    this.ensureCapacity(this.count + 1);
    const size = frame.originalSize, border = frame.trimmedBorder;
    const scaleX = width / size.width, scaleY = height / size.height;
    const left = border.x * scaleX - anchorX * width;
    const bottom = border.z * scaleY - anchorY * height;
    const right = width + border.y * scaleX - anchorX * width;
    const top = height + border.w * scaleY - anchorY * height;
    const radians = angle * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
    const uv = frame.uv, values = this.vertices;
    for (let corner = 0; corner < 4; corner++) {
      const px = corner & 1 ? right : left, py = corner & 2 ? top : bottom;
      const offset = (this.count * 4 + corner) * STRIDE;
      values[offset] = x + px * cosine - py * sine;
      values[offset + 1] = y + px * sine + py * cosine;
      values[offset + 2] = 0;
      values[offset + 3] = uv[corner * 2]; values[offset + 4] = uv[corner * 2 + 1];
      values[offset + 5] = color[0]; values[offset + 6] = color[1];
      values[offset + 7] = color[2]; values[offset + 8] = color[3];
    }
    this.count++;
  }

  end(): void {
    if (this.activeIndices.length !== this.count * 6)
      this.activeIndices = this.drawIndices.subarray(0, this.count * 6);
    this.node.active = this.count > 0;
    this.sprite.markForUpdateRenderData();
  }

  hide(): void { this.count = 0; this.node.active = false; }

  private createData(): any {
    const data = this.sprite.requestRenderData();
    // The real accessor capacity can be reduced by project configuration.
    const accessor = data.accessor as any;
    if (accessor) this.limit = Math.max(1, Math.min(MAX_QUADS_PER_RUN,
      Math.floor(accessor._vCount / 4), Math.floor(accessor._iCount / 6)));
    data.material = this.sprite.getRenderMaterial(0);
    if (this.capacity) this.resizeData(data);
    return data;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) return;
    const capacity = Math.min(this.limit, Math.max(required, this.capacity * 2, 16));
    const vertices = new Float32Array(capacity * 4 * STRIDE);
    vertices.set(this.vertices); this.vertices = vertices;
    this.indices = new Uint16Array(capacity * 6);
    this.drawIndices = new Uint16Array(capacity * 6);
    this.activeIndices = new Uint16Array(0);
    for (let i = 0; i < capacity; i++) {
      const vertex = i * 4, offset = i * 6;
      this.indices[offset] = vertex; this.indices[offset + 1] = vertex + 1;
      this.indices[offset + 2] = vertex + 2; this.indices[offset + 3] = vertex + 1;
      this.indices[offset + 4] = vertex + 3; this.indices[offset + 5] = vertex + 2;
    }
    this.capacity = capacity;
    // UIRenderer.onDisable destroys RenderData. A pooled run (or its parent)
    // may still be inactive while begin/add assemble the next frame. Retain
    // CPU storage now; onEnable -> _flushAssembler -> createData allocates the
    // final capacity when the hierarchy becomes visible again.
    const data = this.sprite.renderData;
    if (data) this.resizeData(data);
  }

  private resizeData(data: any): void {
    data.dataLength = this.capacity * 4;
    data.resize(this.capacity * 4, this.capacity * 6);
    data.chunk.setIndexBuffer(this.indices);
    data.material = this.sprite.getRenderMaterial(0);
  }

  private updateRenderData(): void {
    const data = this.sprite.renderData, frame = this.sprite.spriteFrame;
    if (!data || !frame || !this.count) return;
    data.material = this.sprite.getRenderMaterial(0);
    data.vertDirty = true; data.updateRenderData(this.sprite, frame);
  }

  private fillBuffers(): void {
    const data = this.sprite.renderData;
    if (!data || !this.count) return;
    const chunk = data.chunk, values = chunk.vb, matrix = this.node.worldMatrix;
    // Batcher2D updates this immediately before fillBuffers, including on a
    // parent-only opacity change or after hiding/showing the entire hierarchy.
    const opacity = (this.node as any)._uiProps.opacity;
    const source = this.vertices, stride = data.floatStride;
    for (let i = 0; i < this.count * 4; i++) {
      const from = i * STRIDE, to = i * stride, x = source[from], y = source[from + 1];
      let rhw = matrix.m03 * x + matrix.m07 * y + matrix.m15;
      rhw = rhw ? 1 / rhw : 1;
      values[to] = (matrix.m00 * x + matrix.m04 * y + matrix.m12) * rhw;
      values[to + 1] = (matrix.m01 * x + matrix.m05 * y + matrix.m13) * rhw;
      values[to + 2] = (matrix.m02 * x + matrix.m06 * y + matrix.m14) * rhw;
      values[to + 3] = source[from + 3]; values[to + 4] = source[from + 4];
      values[to + 5] = source[from + 5]; values[to + 6] = source[from + 6];
      values[to + 7] = source[from + 7]; values[to + 8] = source[from + 8] * opacity;
    }
    for (let i = 0; i < this.count * 6; i++) this.drawIndices[i] = chunk.vertexOffset + this.indices[i];
    chunk.vertexAccessor.appendIndices(chunk.bufferId, this.activeIndices);
    chunk.meshBuffer.setDirty(); data.vertDirty = false;
  }
}
