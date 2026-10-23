import { Sprite } from 'cc';
import { CAMERA_BASIS as C } from '../core/projection';

export interface ParticleMeshGeometry {
  positions: number[][]; uv: number[][]; indices: number[]; colors?: number[][];
}
export interface ParticleMeshTransform {
  position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number];
}

/** Unity mesh particles remain textured triangles, projected through the same
 * original camera as the ground simulation. No atlas sheet is used as a quad. */
export class OriginalParticleMesh {
  private readonly points: { x: number; y: number; depth: number }[];
  private readonly triangles: { offset: number; depth: number }[];
  private readonly indices: Uint16Array;
  private readonly drawIndices: Uint16Array;
  private tint?: number[];
  private colorsDirty = true;

  constructor(private readonly sprite: Sprite, private readonly geometry: ParticleMeshGeometry) {
    this.points = geometry.positions.map(() => ({ x: 0, y: 0, depth: 0 }));
    this.triangles = Array.from({ length: geometry.indices.length / 3 }, (_, index) => ({ offset: index * 3, depth: 0 }));
    this.indices = Uint16Array.from(geometry.indices);
    this.drawIndices = new Uint16Array(this.indices.length);
    // Creator's custom assembler seam uses internal fields. It is isolated
    // here and verified against the bundled 3.8.8 Sprite/RenderData sources.
    const spriteBridge = sprite as any;
    spriteBridge.destroyRenderData();
    const assembler = {
      createData: () => this.createData(),
      updateRenderData: () => this.updateRenderData(),
      fillBuffers: () => this.fillBuffers(),
      updateUVs: () => this.updateRenderData(),
      // Sprite.color and setTint may both change before this frame is drawn.
      // Keep only the final color, instead of rewriting every vertex twice.
      updateColor: () => this.invalidateColors(),
    };
    spriteBridge._assembler = assembler;
    spriteBridge._flushAssembler = () => {
      if (!spriteBridge._renderData) spriteBridge._renderData = this.createData();
    };
    spriteBridge._flushAssembler();
    sprite.markForUpdateRenderData();
  }

  update(transform: ParticleMeshTransform): void {
    if (this.geometry.colors) this.colorsDirty = true;
    const [qx, qy, qz, qw] = transform.rotation, [sx, sy, sz] = transform.scale;
    const [px, py, pz] = transform.position;
    for (let index = 0; index < this.points.length; index++) {
      const vertex = this.geometry.positions[index], x = vertex[0] * sx, y = vertex[1] * sy, z = vertex[2] * sz;
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      const wx = px + x + qw * tx + qy * tz - qz * ty;
      const wy = py + y + qw * ty + qz * tx - qx * tz;
      const wz = pz + z + qw * tz + qx * ty - qy * tx;
      const point = this.points[index];
      point.x = C.rightX * wx + C.rightZ * wz;
      point.y = C.upX * wx + C.upY * wy + C.upZ * wz;
      point.depth = C.forwardX * wx + C.forwardY * wy + C.forwardZ * wz;
    }
    for (const triangle of this.triangles) {
      const a = this.geometry.indices, i = triangle.offset;
      triangle.depth = this.points[a[i]].depth + this.points[a[i + 1]].depth + this.points[a[i + 2]].depth;
    }
    this.triangles.sort((a, b) => b.depth - a.depth);
    for (let i = 0; i < this.triangles.length; i++) {
      const from = this.triangles[i].offset;
      for (let corner = 0; corner < 3; corner++) this.indices[i * 3 + corner] = this.geometry.indices[from + corner];
    }
    // Mesh vertices are already in WorldProjection's local coordinate system.
    this.sprite.node.setPosition(0, 0, 0); this.sprite.node.angle = 0; this.sprite.node.setScale(1, 1, 1);
    this.sprite.markForUpdateRenderData();
  }

  /** Dynamic projectile ribbons and pressure fronts already use the projected
   * world plane. Keep their fixed buffers while replacing positions/UV/tints. */
  updateProjected(): void {
    if (this.geometry.colors) this.colorsDirty = true;
    for (let i = 0; i < this.points.length; i++) {
      const source = this.geometry.positions[i], point = this.points[i];
      point.x = source[0]; point.y = source[1]; point.depth = 0;
    }
    this.sprite.node.setPosition(0, 0, 0);
    this.sprite.node.angle = 0; this.sprite.node.setScale(1, 1, 1);
    this.sprite.markForUpdateRenderData();
  }

  /** Keep source HDR vertex multipliers until texture sampling; byte Sprite
   * colors would clamp e.g. the original ring ×2 and missile ×2.5 prematurely. */
  setTint(color: readonly number[]): void {
    if (this.tint && this.tint[0] === color[0] && this.tint[1] === color[1] &&
      this.tint[2] === color[2] && this.tint[3] === color[3]) return;
    const tint = this.tint ?? (this.tint = [1, 1, 1, 1]);
    for (let i = 0; i < 4; i++) tint[i] = color[i];
    this.invalidateColors();
  }

  private invalidateColors(): void {
    this.colorsDirty = true;
    this.sprite.markForUpdateRenderData();
  }

  private createData(): any {
    this.colorsDirty = true;
    const data = this.sprite.requestRenderData();
    data.dataLength = this.points.length; data.resize(this.points.length, this.indices.length);
    // Cocos reserves four indices per vertex, which is enough for quads but
    // not the source impact sphere (2304 indices / 425 vertices). Reserve for
    // the whole shared buffer so later unchecked sprite writes also fit.
    // JSB owns a per-chunk index buffer and retains native pointers to shared
    // data; its separate renderer must keep those allocations unchanged.
    if (!data.chunk.ib) {
      const buffer = data.chunk.meshBuffer;
      const indicesPerVertex = Math.max(6, Math.ceil(this.indices.length / this.points.length));
      const capacity = Math.ceil(buffer.vData.length / data.floatStride) * indicesPerVertex;
      if (buffer.iData.length < capacity) {
        const expanded = new Uint16Array(capacity); expanded.set(buffer.iData); buffer.iData = expanded;
      }
    }
    data.chunk.setIndexBuffer(this.indices); data.material = this.sprite.getRenderMaterial(0);
    return data;
  }

  private updateRenderData(): void {
    const data = this.sprite.renderData, frame = this.sprite.spriteFrame;
    if (!data || !frame) return;
    const values = data.chunk.vb, stride = data.floatStride;
    const uvs = frame.uv;
    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i], uv = this.geometry.uv[i];
      data.data[i].x = point.x; data.data[i].y = point.y;
      values[i * stride + 3] = uvs[0] + (uv?.[0] ?? 0) * (uvs[2] - uvs[0]);
      values[i * stride + 4] = uvs[1] + (uv?.[1] ?? 0) * (uvs[5] - uvs[1]);
    }
    // Batcher2D may overwrite vertex alpha after fillBuffers when an ancestor
    // opacity is dirty. Restore the authored HDR values on every submission,
    // even if the tint is unchanged; the engine then applies opacity as before.
    this.colorsDirty = true;
    this.updateColors();
    data.vertDirty = true; data.updateRenderData(this.sprite, frame);
  }

  private updateColors(): void {
    const data = this.sprite.renderData;
    if (!data || !this.colorsDirty) return;
    const values = data.chunk.vb, color = this.sprite.color, stride = data.floatStride;
    const r = this.tint?.[0] ?? color.r / 255, g = this.tint?.[1] ?? color.g / 255;
    const b = this.tint?.[2] ?? color.b / 255, a = this.tint?.[3] ?? color.a / 255;
    for (let i = 0; i < this.points.length; i++) {
      const tint = this.geometry.colors?.[i], offset = i * stride + 5;
      values[offset] = r * (tint?.[0] ?? 1); values[offset + 1] = g * (tint?.[1] ?? 1);
      values[offset + 2] = b * (tint?.[2] ?? 1); values[offset + 3] = a * (tint?.[3] ?? 1);
    }
    this.colorsDirty = false;
  }

  private fillBuffers(): void {
    const data = this.sprite.renderData;
    if (!data) return;
    this.updateColors();
    const chunk = data.chunk, values = chunk.vb, stride = data.floatStride, matrix = this.sprite.node.worldMatrix;
    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i], offset = i * stride;
      values[offset] = matrix.m00 * point.x + matrix.m04 * point.y + matrix.m12;
      values[offset + 1] = matrix.m01 * point.x + matrix.m05 * point.y + matrix.m13;
      values[offset + 2] = matrix.m02 * point.x + matrix.m06 * point.y + matrix.m14;
    }
    for (let i = 0; i < this.indices.length; i++) this.drawIndices[i] = chunk.vertexOffset + this.indices[i];
    // Use the accessor's checked append path: an upload exception otherwise
    // prevents the normal end-of-frame reset and freezes every later frame.
    chunk.vertexAccessor.appendIndices(chunk.bufferId, this.drawIndices);
    chunk.meshBuffer.setDirty(); data.vertDirty = false;
  }
}
