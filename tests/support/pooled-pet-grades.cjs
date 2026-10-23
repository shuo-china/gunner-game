const assert=require('node:assert/strict');
const {gradeBadgeRendering}=require('./grade-badge-rendering.cjs');

// Compare pooled output with independently-created authored grade labels. The
// reference uses each label's original font profile, atlas page and geometry.
function assertPooledGrades(h,config,include,paint,omitted){
 const {OriginalWeaponUi}=h.modules['./OriginalWeaponUi'],full=new OriginalWeaponUi(h.art,h.hud.ui.assets);
 const roles=Object.values(config.roles).filter(role=>include(role)&&role.Degree_objs?.length>1),parents=[];
 assert.equal(Object.keys(config.nodes).filter(id=>h.hud.ui.get(id)).length,Object.keys(config.nodes).length-omitted);
 const targets=roles.map(role=>h.node(role.Degree_objs[0]));
 for(const role of roles){
  const parent=h.makeNode('AuthoredGradeReference'),actual=h.node(role.Degree_objs[0]).parent.getComponent(h.UITransform);
  parent.getComponent(h.UITransform).setContentSize(actual.width,actual.height);parents.push(parent);
  for(const key of role.Degree_objs){full.create(key,parent);full.rebindTree(key,key);}
 }
 for(const grade of [...Array.from({length:13},(_,i)=>i),...Array.from({length:13},(_,i)=>12-i)])for(const role of roles){
  paint(role,-1);const target=h.node(role.Degree_objs[0]);assert.equal(target.active,false);
  paint(role,grade);assert.equal(target.active,true);
  assert.deepEqual(gradeBadgeRendering(target,h),gradeBadgeRendering(full.node(role.Degree_objs[grade]),h),`${role.type} ${role.node} grade ${grade}`);
  assert.ok(role.Degree_objs.slice(1).every(key=>!h.hud.ui.get(key)));
  // A second unchanged refresh must neither replace nor add glyph nodes.
  const count=target.children.length;paint(role,grade);assert.equal(target.children.length,count);
 }
 assert.deepEqual(roles.map(role=>h.node(role.Degree_objs[0])),targets);
 full.destroy();for(const parent of parents)parent.destroy();
}
module.exports={assertPooledGrades};
