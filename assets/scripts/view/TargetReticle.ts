import { Node } from 'cc';
import { projectWorld, TreeState } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { TargetReticleConfig } from './OriginalFeedbackAssets';
import { decomposeProjectedPlane, projectedSpritePlane } from './OriginalFeedbackMath';

/** Target/Triangle's original 3D DORotate projected through the fixed camera. */
export class TargetReticle {
  readonly node: Node;
  private readonly rotation: Node;
  private readonly baseInnerAngle: number;
  private phase = 0;
  private started = false;

  constructor(art: ArtLibrary, parent: Node, private readonly config: TargetReticleConfig) {
    this.node = makeNode('Target', parent);
    const outer = makeNode('ProjectedPlaneOuterRotation', this.node);
    const stretch = makeNode('ProjectedPlaneScale', outer);
    this.rotation = makeNode('Triangle_DOTween', stretch);
    const plane = decomposeProjectedPlane(projectedSpritePlane(config.planeQuaternion));
    outer.angle = plane.outer;
    stretch.setScale(plane.x, plane.y, 1);
    this.baseInnerAngle = plane.inner;
    this.rotation.angle = plane.inner;
    const sprite = art.image('OriginalTargetSprite', config.sprite, this.rotation);
    sprite.setScale(config.scale[0], config.scale[1], 1);
    this.node.active = false;
  }

  update(dt: number, target?: TreeState): void {
    // Target is initially inactive, so its child's Awake creates the tween on
    // first activation. Thereafter DOTween has no OnDisable pause.
    if (target) this.started = true;
    if (this.started) this.phase = (this.phase + Math.max(0, dt) * this.config.degreesPerSecond) % 360;
    this.rotation.angle = this.baseInnerAngle + this.phase;
    this.node.active = !!target;
    if (!target) return;
    // The original tracks the attack Collider's Transform, whose local XZ is (-2,+2),
    // then applies Triangle's local world-Y offset, not the collider's height center.
    const p = projectWorld({x: (target.collider.minX + target.collider.maxX) / 2,
      z: (target.collider.minZ + target.collider.maxZ) / 2}, this.config.height);
    this.node.setPosition(p.x, p.y, 0);
  }

  reset(): void { this.node.active = false; }
  destroy(): void { this.node.destroy(); }
}
