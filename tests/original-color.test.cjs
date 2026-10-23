const test=require('node:test');
const assert=require('node:assert/strict');
const {srgbToLinear,linearToSrgb}=require('./.build/color/OriginalColorMath.js');
const close=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const ldr=value=>Math.max(0,Math.min(1,value));
const over=(source,alpha,destination)=>ldr(source*alpha+destination*(1-alpha));
const add=(source,alpha,destination)=>ldr(source*alpha+destination);

test('URP render scale truncates float pixel extents and does not impose a 2048 cap',()=>{
  const {originalRenderExtent}=require('./.build/color/OriginalColorMath.js');
  assert.equal(originalRenderExtent(721),504);
  assert.equal(originalRenderExtent(1281),896);
  assert.equal(originalRenderExtent(3840),2688);
  assert.equal(originalRenderExtent(1),1);
});

test('source white opaque sprite remains unchanged after world decode and one presentation encode',()=>{
  for(const value of [0,.01,.04045,.2,.5,.77254903,1])close(linearToSrgb(srgbToLinear(value)),value,3e-8);
  close(srgbToLinear(.5),.21404114048223255);
  close(linearToSrgb(.5),.7353569830524495);
});

test('half-transparent white source blends in linear light without gamma-correcting alpha',()=>{
  const alpha=.5;
  const displayed=linearToSrgb(over(srgbToLinear(1),alpha,srgbToLinear(0)));
  close(displayed,.7353569830524495);
  assert.ok(Math.abs(displayed-.5)>.23,'blending already encoded RGB would give the wrong fade');
  assert.ok(Math.abs(displayed-linearToSrgb(srgbToLinear(alpha)))>.23,'alpha is a coverage value, not an sRGB channel');
});

test('source SRC_ALPHA/ONE adds to the linear background and clamps the LDR target before presentation',()=>{
  const equalHalves=linearToSrgb(add(srgbToLinear(.5),1,srgbToLinear(.5)));
  close(equalHalves,.6858361190643691);
  assert.ok(equalHalves<.7,'adding encoded halves would incorrectly clip to white');
  close(linearToSrgb(add(srgbToLinear(1),1,srgbToLinear(.8))),1);
});

test('overlapping hit glow and alpha sparks encode only after their complete world composite',()=>{
  const background=srgbToLinear(.2);
  const glow=add(srgbToLinear(.8),.35,background);
  const composed=over(srgbToLinear(1),.4,glow);
  const displayed=linearToSrgb(composed);
  close(displayed,.7652952281224784,1e-8);
  assert.ok(Math.abs(displayed-linearToSrgb(linearToSrgb(composed)))>.1,
    'encoding an already encoded presentation brightens the composite again');
  // An RGBA8 linear target introduces quantization, not a second transfer curve.
  const quantized=linearToSrgb(Math.round(composed*255)/255);
  assert.ok(Math.abs(quantized-displayed)<.003);
});

test('source additive and normal alpha blend equations stay distinct for transparent texture edges',()=>{
  const source=srgbToLinear(.8),background=srgbToLinear(.3),alpha=.25;
  const glow=add(source,alpha,background),spark=over(source,alpha,background);
  close(glow-spark,background*alpha);
  close(add(source,0,background),background);
  close(over(source,0,background),background);
});
