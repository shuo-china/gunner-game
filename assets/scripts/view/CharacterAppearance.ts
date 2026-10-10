import { Node } from 'cc';

/** Replace a whole character rig without changing movement, targets or damage. */
export interface CharacterAppearance {
  /** Ground/feet origin in the projected world, independent of image bounds. */
  readonly node: Node;
  readonly shadow: Node;
  readonly gunPivot: Node;
  readonly muzzle: Node;
  setAimTarget?(offset: {x:number;z:number}|null): void;
  /** Change only the body pivot, retaining this frame's local animated pose. */
  setFacing(facing: number): void;
  /** Run procedural Cat.Update aiming before Attack samples its firing point. */
  updatePose(dt: number, moving: boolean, facing: number): void;
  /** Resume recoil, evaluate Normal Animator and particles after shot events. */
  updateEffects(dt: number): void;
  update(dt: number, moving: boolean, facing: number): void;
  fire(): void;
  reset(): void;
  getMuzzleProjectionOffset(): {x:number;y:number};
  /** Original physical firing point relative to the cat on the requested Y plane. */
  getBulletSpawnOffset(height: number): {x:number;z:number};
}
