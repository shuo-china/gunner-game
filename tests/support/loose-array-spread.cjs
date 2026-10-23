const ts = require('typescript');

// Creator 3.8 uses Babel's iterableIsArray assumption: [...set] becomes
// [].concat(set), while for-of still honors iterators. Reproduce that exact
// boundary without requiring Creator or its private Babel packages in CI.
function looseArraySpread(context) {
  const f = context.factory;
  const visit = node => {
    node = ts.visitEachChild(node, visit, context);
    if (!ts.isArrayLiteralExpression(node) || !node.elements.some(ts.isSpreadElement)) return node;
    return f.createCallExpression(
      f.createPropertyAccessExpression(f.createArrayLiteralExpression(), 'concat'), undefined,
      node.elements.map(element => ts.isSpreadElement(element) ? element.expression : f.createArrayLiteralExpression([element])));
  };
  return node => ts.visitNode(node, visit);
}

module.exports = { looseArraySpread };
