import { Color, gfx, Graphics, Node, UITransform, Vec3 } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { STAFF_PREVIEW_PPU, StaffCastPose } from './WeaponAttackAnimation';

/** The accepted staff study's glow, three orbiting stars and release ring.
 * This is a view of the combat attack phase, never another firing clock. */
export class StaffCastEffect {
  private tint = [161 / 255, 231 / 255, 235 / 255];

  setColor(color?: readonly number[]): void {
    this.tint = color?.slice(0, 3) ?? [161 / 255, 231 / 255, 235 / 255];
  }

  private color(alpha: number, white = 0): Color {
    const c = this.tint.map(value => Math.round(255 * (value + (1 - value) * white)));
    return new Color(c[0], c[1], c[2], alpha);
  }
  private readonly node: Node;
  private readonly graphic: Graphics;
  private readonly parentTransform: UITransform;
  private readonly muzzleTransform: UITransform;
  private readonly origin = new Vec3();
  private readonly axis = new Vec3();
  private readonly axisWorld = new Vec3();
  private readonly axisLocal = new Vec3();

  constructor(art: ArtLibrary, parent: Node, private readonly muzzle: Node) {
    this.node = makeNode('StaffCastGlowAndStars', parent);
    this.node.setScale(1 / STAFF_PREVIEW_PPU, 1 / STAFF_PREVIEW_PPU, 1);
    this.graphic = this.node.addComponent(Graphics);
    if (art.linearGraphicsMaterial) {
      (this.graphic as Graphics & {srcBlendFactor: gfx.BlendFactor}).srcBlendFactor = gfx.BlendFactor.ONE;
      this.graphic.customMaterial = art.linearGraphicsMaterial;
    }
    this.parentTransform = parent.getComponent(UITransform)!;
    this.muzzleTransform = muzzle.getComponent(UITransform)!;
    this.node.active = false;
  }

  update(pose: StaffCastPose): void {
    const charge = pose.charge, flash = pose.flash;
    if (charge <= 0 && flash <= 0) { this.reset(); return; }
    this.node.active = true;
    // Convert the real registered tip through its full sprite, cast pivot,
    // bone and facing transforms. Texture dimensions never define the origin.
    this.parentTransform.convertToNodeSpaceAR(this.muzzle.worldPosition, this.origin);
    this.node.setPosition(this.origin.x, this.origin.y, 0);
    this.axis.set(1, 0, 0);
    this.muzzleTransform.convertToWorldSpaceAR(this.axis, this.axisWorld);
    this.parentTransform.convertToNodeSpaceAR(this.axisWorld, this.axisLocal);
    this.node.angle = Math.atan2(this.axisLocal.y - this.origin.y, this.axisLocal.x - this.origin.x) * 180 / Math.PI;
    const g = this.graphic;
    g.clear();
    if (charge > 0) {
      const radius = 14 + 15 * charge;
      // Layered translucent disks approximate the study's soft radial glow
      // without allocating textures or retaining particles after a switch.
      for (let i = 12; i >= 1; i--) {
        g.fillColor = this.color(18);
        g.circle(0, 0, 3 + (radius - 3) * i / 12); g.fill();
      }
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3 + pose.time * 12, orbit = 24 - 8 * charge;
        this.star(Math.cos(angle) * orbit, Math.sin(angle) * orbit, 2.8 + charge,
          Math.sin(charge * Math.PI * .5) * .8);
      }
    }
    if (flash > 0) {
      g.strokeColor = this.color(Math.round(255 * flash * .7));
      g.lineWidth = 2;
      g.ellipse(0, 0, 9 + 14 * flash, 16 + 10 * flash); g.stroke();
    }
  }

  reset(): void {
    if (!this.node.active) return;
    this.node.active = false;
    this.graphic.clear();
  }

  destroy(): void {
    this.reset();
    if (this.node.isValid) this.node.destroy();
  }

  private star(x: number, y: number, radius: number, alpha: number): void {
    const g = this.graphic;
    g.fillColor = this.color(Math.round(alpha * 255), .8);
    g.strokeColor = this.color(Math.round(alpha * 255));
    g.lineWidth = 1;
    g.moveTo(x, y + radius);
    g.lineTo(x + radius * .35, y + radius * .3);
    g.lineTo(x + radius, y);
    g.lineTo(x + radius * .3, y - radius * .3);
    g.lineTo(x, y - radius);
    g.lineTo(x - radius * .3, y - radius * .3);
    g.lineTo(x - radius, y);
    g.lineTo(x - radius * .3, y + radius * .3);
    g.close(); g.fill(); g.stroke();
  }
}
