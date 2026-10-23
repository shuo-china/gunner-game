import { WEAPON_COUNT } from '../core/WeaponCatalog';

interface SpawnRecord { time: number; x: number; y: number; z: number; }

/** Bullet.SpawnFX -> FXThrottle.CanSpawn, shared by every weapon and actor.
 * A render-event batch is one Unity frame, including all its physics steps. */
export class OriginalImpactFxThrottle {
  private readonly records: SpawnRecord[] = Array.from({ length: WEAPON_COUNT }, () => ({ time: 0, x: 0, y: 0, z: 0 }));
  private spawnedThisFrame = 0;
  private time = 0;

  beginFrame(scaledTime: number): void {
    this.time = Math.fround(scaledTime);
    this.spawnedThisFrame = 0;
  }

  canSpawn(weaponId: number, position: { x: number; z: number }, height: number, scaledTime = this.time): boolean {
    if (this.spawnedThisFrame >= 3) return false;
    const previous = this.records[weaponId];
    if (!previous) return false;
    // Unity Time.time is the current physics tick inside collision callbacks;
    // all requests still share the render frame's three-spawn budget.
    const time = Math.fround(scaledTime);
    const x = Math.fround(position.x), y = Math.fround(height), z = Math.fround(position.z);
    const dx = Math.fround(x - previous.x), dy = Math.fround(y - previous.y), dz = Math.fround(z - previous.z);
    const distanceSquared = Math.fround(Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy)) + Math.fround(dz * dz));
    // Source _UNK_0106c094 is IEEE754 float 0.05; distance is an OR escape.
    if (Math.fround(time - previous.time) < Math.fround(0.05) && distanceSquared < 2.25) return false;
    previous.time = time; previous.x = x; previous.y = y; previous.z = z;
    this.spawnedThisFrame++;
    return true;
  }
}
