/** Shared scalar velocity limiting for the source particle modules.
 * The serialized limit/dampen values are original. Unity's internal native
 * integrator is unavailable: this retains the existing 60 Hz damping
 * approximation, with exponential attenuation between those reference steps.
 * Do not treat this approximation as an extracted Unity C++ formula.
 */
export function particleVelocityKeep(speed:number,limit:number,dampen:number,dt:number):number {
  if(!(dt>0)||!(speed>limit)||!(speed>0))return 1;
  const attenuation=Math.pow(1-Math.max(0,Math.min(1,dampen)),dt*60);
  return (Math.max(0,limit)+(speed-Math.max(0,limit))*attenuation)/speed;
}
