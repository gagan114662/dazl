// Next 16 forwards recoverable hydration errors to window.reportError but drops React's second argument.
module.exports = function retainReactComponentStack(source) {
  const signature = 'const onRecoverableError = (error)=>{';
  const dispatch = '(0, _reportglobalerror.reportGlobalError)(cause);';
  if (source.split(signature).length !== 2 || source.split(dispatch).length !== 2) {
    throw new Error('Next recoverable error callback changed; review the component stack integration');
  }
  return source
    .replace(signature, 'const onRecoverableError = (error, errorInfo)=>{')
    .replace(dispatch, `
      try {
        if (cause instanceof Error && typeof errorInfo?.componentStack === 'string') {
          Object.defineProperty(cause, Symbol.for('dazl.react.componentStack'), { value: errorInfo.componentStack, configurable: true });
        }
      } catch { /* diagnostics cannot interrupt Next's recovery */ }
      ${dispatch}
    `);
};
