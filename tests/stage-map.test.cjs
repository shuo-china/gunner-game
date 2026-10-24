const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const core = require('./.build/core/index.js');
const original = require('./fixtures/original-stage-balance.json');
const assets = require('../assets/resources/art/stages/config.json');
const { DecimalAmount, createStageDefinition, generateFirstMap, getStageHealth, getStageMoney, getStageTreeCount } = core;

test('all 5000 native precomputed health and money values match the original serialized balance', () => {
  const actual = [getStageHealth, getStageMoney].map(fn => Array.from({length:5000}, (_, i) => fn(i).toJSON()));
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(actual)).digest('hex'), original.sha256);
  for (const {stage,health,money} of original.samples) {
    assert.deepEqual(getStageHealth(stage).toJSON(), health);
    assert.deepEqual(getStageMoney(stage).toJSON(), money);
  }
});

test('stage 5000 and later extend using native precision cuts without Number overflow', () => {
  for (const fn of [getStageHealth,getStageMoney]) {
    assert.deepEqual(fn(5000), fn(4999).mul(3).truncateSignificant(2));
    assert.deepEqual(fn(5001), fn(4999).mul(9).truncateSignificant(2));
    const high = fn(1000000);
    assert.ok(high.compare(fn(5001)) > 0);
    assert.equal(typeof high.digits, 'string');
    assert.ok(high.digits.length <= 2);
    assert.ok(high.format().includes('e+'));
  }
});

test('five waves use the authored grid banks, moving north wall and fifth-wave Boss', () => {
  for (const stage of [0,1,6,7,99,5000]) for (let wave=0;wave<5;wave++) {
    const map = createStageDefinition(stage,wave,9183), count = getStageTreeCount(stage);
    assert.equal(map.trees.length, count*(wave+1)+(wave===4?1:0));
    assert.equal(new Set(map.trees.map(t=>t.id)).size,map.trees.length);
    assert.equal(map.skinIndex,stage%10);
    assert.equal(map.bounds.maxZ,(wave+1)*50+57.5);
    assert.equal(map.bulletWalls[1].minZ,map.bounds.maxZ);
    assert.equal(map.bulletWalls[1].maxZ,map.bounds.maxZ+5);
    for (const tree of map.trees.filter(t=>t.degree!==3)) {
      const grid=Math.floor(tree.id/100), slot=tree.id%100;
      assert.ok(Math.abs(tree.position.x-((slot%10)*5-22.5))<=1.5);
      assert.ok(Math.abs(tree.position.z-(Math.floor(slot/10)*5+27.5+grid*50))<=1.5);
      const healthPrecision = tree.degree === 1 ? 17 : stage === 0 ? 5 : 2;
      assert.equal(tree.healthPrecision, healthPrecision);
      assert.equal(tree.health.compare(getStageHealth(stage).mul([1,1.8,3][tree.degree]).truncateSignificant(healthPrecision)),0);
      // The serialized first table entries retain p5; subsequent entries are
      // p2. Degree-1's double multiplier promotes either source to p17.
      const rewardPrecision = tree.degree === 1 ? 17 : stage === 0 ? 5 : 2;
      assert.equal(tree.rewardPrecision,rewardPrecision);
      assert.equal(tree.reward.compare(getStageMoney(stage).mul([1,1.8,3][tree.degree]).truncateSignificant(rewardPrecision)),0);
    }
    const boss=map.trees.find(t=>t.degree===3);
    if (wave===4) {
      assert.deepEqual(boss.position,{x:0,z:282});
      assert.deepEqual(boss.collider,{minX:-3.5,maxX:3.5,minZ:278.5,maxZ:285.5});
      assert.equal(boss.healthPrecision, stage === 0 ? 5 : 2);
      assert.equal(boss.health.compare(getStageHealth(stage).mul(35).truncateSignificant(boss.healthPrecision)),0);
      assert.equal(boss.reward.compare(getStageMoney(stage).mul(100)),0);
      assert.equal(boss.rewardPrecision,stage === 0 ? 5 : 3,'Boss money multiplier is int 100 (p3), retaining first-stage p5');
    } else assert.equal(boss,undefined);
  }
});

test('stage generation is deterministic, isolated, and preserves the first-wave wrapper', () => {
  assert.deepEqual(generateFirstMap(73),createStageDefinition(0,0,73).trees);
  assert.deepEqual(createStageDefinition(2,3,73),createStageDefinition(2,3,73));
  const first=createStageDefinition(0,0,73), second=createStageDefinition(0,0,73);
  first.trees[0].health=DecimalAmount.from(0);first.bulletWalls[0].minX=999;
  assert.ok(second.trees[0].health.compare(0)>0);assert.equal(second.bulletWalls[0].minX,-35);
  assert.throws(()=>createStageDefinition(0,5,1));assert.throws(()=>createStageDefinition(-1,0,1));
  assert.throws(()=>getStageHealth(NaN));
});

test('metadata assets preserve all ten maps, forty trees and distinct Boss geometry', () => {
  assert.equal(assets.skins.length,10);assert.equal(assets.treeSprites.length,40);
  assert.equal(assets.skins[0].sprites.ground.path,'art/stages/maps/0/forest_ruins/ground');
  assert.equal(assets.skins[7].sprites.ground.path,'art/stages/maps/7/ground');
  assert.deepEqual(assets.treeSprites.slice(0,4).map(spec=>spec.path),[28,29,30,31].map(id=>`art/stages/trees/${id}`));
  assert.deepEqual(assets.treeSprites.slice(28,32).map(spec=>spec.path),['standing_stone','column','stone_ring','shrine'].map(name=>`art/stages/maps/0/forest_ruins/${name}`));
  assert.deepEqual(assets.layout.degreeRates,[[80,20,0,0],[50,45,5,0],[20,55,25,0],[5,35,60,0],[0,15,85,0]]);
  assert.deepEqual(assets.layout.grids.map(g=>g.grid.position[2]),[50,100,150,200,250]);
  assert.deepEqual(assets.boss.collider.size,[7,6,7]);
  assert.deepEqual(assets.boss.skinScale,[2.5,2.5]);
  assert.equal(assets.boss.healthBar.followsBounce,false);
  assert.equal(assets.normal.healthBar.followsBounce,true);
  assert.equal(assets.boss.death.moneyParticles,5,'Boss_Spawn does not override serialized is_Boss=0');
  assert.equal(assets.boss.sparkles.timeEmissionRate,14);
  assert.equal(assets.boss.sparkles.looping,true);
  assert.equal(assets.boss.sparkles.id,'level0:67069');
  for (const skin of assets.skins) assert.equal(Object.keys(skin.fillColors).length,12);
});
